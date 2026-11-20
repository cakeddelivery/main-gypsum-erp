import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "./parse";
import { CHANNEL_OF, incomeSig, lineKey, mapStatus, orderSig } from "./rules";
import { resolveSkuKeys } from "./sku";
import { linkOrdersToReturns } from "./link";

/**
 * Impor penjualan marketplace. HANYA menulis ke tabel Marketplace* — tidak menyentuh stok, mutasi, jurnal, maupun transaksi.
 * Setiap file = satu batch (MarketplaceImport) yang bisa dibatalkan utuh.
 */
export class MarketplaceImportError extends Error {}

type Actor = { id: string; name: string };
export type ImportFile = { fileName: string; storeId: string; parsed: ParsedFile };

export type FilePreview = {
  fileName: string;
  storeName: string;
  platform: string;
  kind: string;
  channel: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  seller?: string;
  total: number;
  baru: number;
  diperbarui: number;
  dilewati: number;
  withdrawals: number;
  adsRows: number;
  /** SKU yang belum bisa dikenali (kunci, contoh nama, jumlah pesanan) */
  unmapped: { key: string; sku: string; name: string; orders: number }[];
  /** Penghasilan yang pesanannya belum ada di ERP (disimpan; cocok otomatis saat order diunggah) */
  incomeNoOrder: number;
};
export type Preview = { files: FilePreview[]; totals: { baru: number; diperbarui: number; dilewati: number; perluDicek: number } };

const chunk = <T>(a: T[], n = 3000) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

async function checkStore(storeId: string) {
  const s = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, code: true } });
  if (!s) throw new MarketplaceImportError("Pilih toko untuk setiap file");
  return s;
}

export async function previewImport(files: ImportFile[]): Promise<Preview> {
  if (!files.length) throw new MarketplaceImportError("Pilih minimal satu file");
  const out: FilePreview[] = [];
  // pesanan yang ikut diunggah bersamaan (agar penghasilan tidak dianggap "tanpa order")
  const inUpload = new Set<string>();
  for (const f of files) if (f.parsed.kind === "ORDER") for (const o of f.parsed.orders) inUpload.add(`${f.storeId}|${CHANNEL_OF[f.parsed.platform]}|${o.orderNo}`);
  for (const f of files) {
    const store = await checkStore(f.storeId);
    const channel = CHANNEL_OF[f.parsed.platform];
    const p: FilePreview = {
      fileName: f.fileName, storeName: store.name, platform: f.parsed.platform, kind: f.parsed.kind, channel, periodFrom: f.parsed.periodFrom, periodTo: f.parsed.periodTo, seller: f.parsed.info.seller,
      total: 0, baru: 0, diperbarui: 0, dilewati: 0, withdrawals: 0, adsRows: 0, unmapped: [], incomeNoOrder: 0,
    };
    if (f.parsed.kind === "ORDER") {
      const orders = f.parsed.orders;
      p.total = orders.length;
      const exist = new Map<string, string | null>();
      for (const part of chunk(orders.map((o) => o.orderNo))) for (const e of await prisma.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } }, select: { orderNo: true, sig: true } })) exist.set(e.orderNo, e.sig);
      for (const o of orders) {
        const sig = orderSig(o, mapStatus(channel, o));
        if (!exist.has(o.orderNo)) p.baru++;
        else if (exist.get(o.orderNo) === sig) p.dilewati++;
        else p.diperbarui++;
      }
      const keyOrders = new Map<string, { sku: string; name: string; orders: Set<string> }>();
      for (const o of orders) for (const l of o.lines) {
        const k = lineKey(channel, l.sku, l.variation);
        const e = keyOrders.get(k) ?? { sku: [l.sku, l.variation].filter(Boolean).join(" · "), name: l.name ?? "", orders: new Set<string>() };
        e.orders.add(o.orderNo);
        keyOrders.set(k, e);
      }
      const res = await resolveSkuKeys([...keyOrders.keys()]);
      p.unmapped = [...keyOrders.entries()].filter(([k]) => !res.has(k)).map(([key, v]) => ({ key, sku: v.sku || "(tanpa SKU)", name: v.name, orders: v.orders.size })).sort((a, b) => b.orders - a.orders);
    } else {
      const rows = f.parsed.incomes;
      p.total = rows.length;
      p.adsRows = rows.filter((r) => r.kind !== "ORDER").length;
      p.withdrawals = f.parsed.withdrawals.length;
      const exist = new Map<string, string | null>();
      for (const part of chunk(rows.map((r) => r.refNo))) for (const e of await prisma.marketplaceIncome.findMany({ where: { storeId: f.storeId, channel, refNo: { in: part } }, select: { kind: true, refNo: true, sig: true } })) exist.set(`${e.kind}|${e.refNo}`, e.sig);
      for (const r of rows) {
        const k = `${r.kind}|${r.refNo}`;
        if (!exist.has(k)) p.baru++;
        else if (exist.get(k) === incomeSig(r)) p.dilewati++;
        else p.diperbarui++;
      }
      const orderRefs = rows.filter((r) => r.kind === "ORDER").map((r) => r.refNo);
      const have = new Set<string>();
      for (const part of chunk(orderRefs)) for (const e of await prisma.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } }, select: { orderNo: true } })) have.add(e.orderNo);
      p.incomeNoOrder = orderRefs.filter((r) => !have.has(r) && !inUpload.has(`${f.storeId}|${channel}|${r}`)).length;
    }
    out.push(p);
  }
  const sum = (k: "baru" | "diperbarui" | "dilewati") => out.reduce((a, f) => a + f[k], 0);
  return { files: out, totals: { baru: sum("baru"), diperbarui: sum("diperbarui"), dilewati: sum("dilewati"), perluDicek: out.reduce((a, f) => a + f.unmapped.length + (f.incomeNoOrder ? 1 : 0), 0) } };
}

// ---------- foto kondisi (untuk pembatalan) ----------
const BIG_O = ["subtotal", "discount", "shippingPaid", "total", "refundAmount"] as const;
const DATE_O = ["orderedAt", "paidAt", "completedAt"] as const;
const SCALAR_O = ["rawStatus", "rawSubstatus", "rawReturn", "cancelReason", "status", "trackingNo", "shipOption", "courier", "paymentMethod", "city", "province", "creatorHandle", "returnQty", "sig", "lastImportId", ...BIG_O, ...DATE_O] as const;
const BIG_I = ["released", "productAmt", "refundAmt", "fees"] as const;
const DATE_I = ["orderedAt", "releasedAt"] as const;
const SCALAR_I = ["feeDetail", "sig", "lastImportId", ...BIG_I, ...DATE_I] as const;
const ser = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => { const v = row[k]; return [k, typeof v === "bigint" ? { $big: v.toString() } : v instanceof Date ? { $date: v.toISOString() } : v ?? null]; }));
const des = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => { const x = v as { $big?: string; $date?: string } | null; return [k, x && typeof x === "object" && "$big" in x ? BigInt(x.$big!) : x && typeof x === "object" && "$date" in x ? new Date(x.$date!) : v]; }));

const orderData = (o: ParsedOrder, status: string, importId: string) => ({
  rawStatus: o.rawStatus, rawSubstatus: o.rawSubstatus, rawReturn: o.rawReturn, cancelReason: o.cancelReason, status, trackingNo: o.trackingNo, shipOption: o.shipOption, courier: o.courier, paymentMethod: o.paymentMethod,
  city: o.city, province: o.province, creatorHandle: o.creatorHandle, orderedAt: o.orderedAt, paidAt: o.paidAt, completedAt: o.completedAt,
  subtotal: BigInt(Math.round(o.subtotal)), discount: BigInt(Math.round(o.discount)), shippingPaid: BigInt(Math.round(o.shippingPaid)), total: BigInt(Math.round(o.total)), refundAmount: BigInt(Math.round(o.refundAmount)), returnQty: o.returnQty,
  sig: orderSig(o, status), lastImportId: importId,
});
const lineRows = (orderId: string, channel: string, o: ParsedOrder) => o.lines.map((l, i) => ({ id: randomUUID(), orderId, sku: l.sku, variation: l.variation, skuKey: lineKey(channel, l.sku, l.variation), name: l.name, qty: l.qty, unitPrice: BigInt(Math.round(l.unitPrice)), amount: BigInt(Math.round(l.amount)), returnQty: l.returnQty, sortOrder: i }));
const incomeData = (r: ParsedIncome, importId: string) => ({
  orderedAt: r.orderedAt, releasedAt: r.releasedAt, released: BigInt(r.released), productAmt: BigInt(r.productAmt), refundAmt: BigInt(r.refundAmt), fees: BigInt(r.fees), feeDetail: r.feeDetail as Prisma.InputJsonValue, sig: incomeSig(r), lastImportId: importId,
});

type Tx = Prisma.TransactionClient;

/** Cocokkan penghasilan ↔ pesanan (no. pesanan sama, toko & kanal sama). Hanya mengisi tautan; aman diulang. */
export async function linkIncome(tx: Tx | typeof prisma, storeId: string, channel: string) {
  await tx.$executeRaw`UPDATE "MarketplaceOrder" o SET "incomeId" = i."id" FROM "MarketplaceIncome" i
    WHERE o."incomeId" IS NULL AND o."storeId" = ${storeId} AND o."channel" = ${channel} AND i."storeId" = o."storeId" AND i."channel" = o."channel" AND i."kind" = 'ORDER' AND i."refNo" = o."orderNo"
    AND NOT EXISTS (SELECT 1 FROM "MarketplaceOrder" x WHERE x."incomeId" = i."id")`;
}

async function commitOrders(tx: Tx, f: ImportFile, channel: string, importId: string) {
  const orders = f.parsed.orders;
  const exist = new Map<string, { id: string; sig: string | null }>();
  for (const part of chunk(orders.map((o) => o.orderNo))) for (const e of await tx.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } } })) exist.set(e.orderNo, { id: e.id, sig: e.sig });
  const news: ParsedOrder[] = [];
  let upd = 0, skip = 0;
  for (const o of orders) {
    const status = mapStatus(channel, o);
    const e = exist.get(o.orderNo);
    if (!e) {
      news.push(o);
      continue;
    }
    if (e.sig === orderSig(o, status)) {
      skip++;
      continue;
    }
    const before = await tx.marketplaceOrder.findUniqueOrThrow({ where: { id: e.id }, include: { lines: true } });
    await tx.marketplaceChange.create({ data: { importId, table: "ORDER", rowId: e.id, before: { ...ser(before as unknown as Record<string, unknown>, SCALAR_O), lines: before.lines.map((l) => ({ ...ser(l as unknown as Record<string, unknown>, ["id", "sku", "variation", "skuKey", "name", "qty", "unitPrice", "amount", "returnQty", "sortOrder"]) })) } as Prisma.InputJsonValue } });
    await tx.marketplaceOrder.update({ where: { id: e.id }, data: orderData(o, status, importId) });
    await tx.marketplaceOrderLine.deleteMany({ where: { orderId: e.id } });
    await tx.marketplaceOrderLine.createMany({ data: lineRows(e.id, channel, o) });
    upd++;
  }
  for (const part of chunk(news, 500)) {
    const ids = part.map(() => randomUUID());
    await tx.marketplaceOrder.createMany({ data: part.map((o, i) => ({ id: ids[i], storeId: f.storeId, channel, orderNo: o.orderNo, importId, ...orderData(o, mapStatus(channel, o), importId) })) });
    await tx.marketplaceOrderLine.createMany({ data: part.flatMap((o, i) => lineRows(ids[i], channel, o)) });
  }
  return { baru: news.length, diperbarui: upd, dilewati: skip };
}

async function commitIncome(tx: Tx, f: ImportFile, channel: string, importId: string) {
  const rows = f.parsed.incomes;
  const exist = new Map<string, { id: string; sig: string | null }>();
  for (const part of chunk(rows.map((r) => r.refNo))) for (const e of await tx.marketplaceIncome.findMany({ where: { storeId: f.storeId, channel, refNo: { in: part } } })) exist.set(`${e.kind}|${e.refNo}`, { id: e.id, sig: e.sig });
  const news: ParsedIncome[] = [];
  let upd = 0, skip = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.kind}|${r.refNo}`;
    if (seen.has(k)) continue; // baris ganda dalam satu file: ambil yang pertama
    seen.add(k);
    const e = exist.get(k);
    if (!e) {
      news.push(r);
      continue;
    }
    if (e.sig === incomeSig(r)) {
      skip++;
      continue;
    }
    const before = await tx.marketplaceIncome.findUniqueOrThrow({ where: { id: e.id } });
    await tx.marketplaceChange.create({ data: { importId, table: "INCOME", rowId: e.id, before: ser(before as unknown as Record<string, unknown>, SCALAR_I) as Prisma.InputJsonValue } });
    await tx.marketplaceIncome.update({ where: { id: e.id }, data: incomeData(r, importId) });
    upd++;
  }
  for (const part of chunk(news, 1000)) await tx.marketplaceIncome.createMany({ data: part.map((r) => ({ storeId: f.storeId, channel, kind: r.kind, refNo: r.refNo, importId, ...incomeData(r, importId) })) });
  let wd = 0;
  const wrows = f.parsed.withdrawals;
  if (wrows.length) {
    const res = await tx.marketplaceWithdrawal.createMany({ data: wrows.map((w) => ({ storeId: f.storeId, channel, txType: w.txType, refId: w.refId, requestedAt: w.requestedAt, doneAt: w.doneAt, amount: BigInt(w.amount), status: w.status, importId })), skipDuplicates: true });
    wd = res.count;
  }
  return { baru: news.length, diperbarui: upd, dilewati: skip, withdrawals: wd };
}

export async function commitImport(actor: Actor, files: ImportFile[]) {
  if (!files.length) throw new MarketplaceImportError("Pilih minimal satu file");
  const results: { importId: string; fileName: string; baru: number; diperbarui: number; dilewati: number }[] = [];
  // pesanan dulu, penghasilan sesudahnya (tautan terisi otomatis di akhir)
  const sorted = [...files].sort((a, b) => (a.parsed.kind === b.parsed.kind ? 0 : a.parsed.kind === "ORDER" ? -1 : 1));
  for (const f of sorted) {
    await checkStore(f.storeId);
    const channel = CHANNEL_OF[f.parsed.platform];
    const r = await prisma.$transaction(
      async (tx) => {
        const imp = await tx.marketplaceImport.create({ data: { createdBy: actor.name, storeId: f.storeId, channel, kind: f.parsed.kind, fileName: f.fileName.slice(0, 200), periodFrom: f.parsed.periodFrom, periodTo: f.parsed.periodTo } });
        const stats = f.parsed.kind === "ORDER" ? await commitOrders(tx, f, channel, imp.id) : await commitIncome(tx, f, channel, imp.id);
        // Impor ulang yang identik tidak meninggalkan batch kosong (tidak ada yang perlu dibatalkan)
        if (!stats.baru && !stats.diperbarui && !("withdrawals" in stats && stats.withdrawals)) {
          await tx.marketplaceImport.delete({ where: { id: imp.id } });
          return { importId: "", fileName: f.fileName, ...stats };
        }
        await tx.marketplaceImport.update({ where: { id: imp.id }, data: { stats } });
        await linkIncome(tx, f.storeId, channel);
        return { importId: imp.id, fileName: f.fileName, ...stats };
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    results.push(r);
  }
  await linkOrdersToReturns().catch(() => {});
  await audit(actor, "MARKETPLACE_IMPOR", "MarketplaceImport", results.map((r) => r.importId).filter(Boolean).join(","), results.map((r) => `${r.fileName}: +${r.baru} ~${r.diperbarui} =${r.dilewati}`));
  return results;
}

/** Batalkan satu batch: hapus baris yang dibuat batch itu & kembalikan baris yang diperbarui ke kondisi sebelumnya */
export async function undoImport(actor: Actor, importId: string) {
  const imp = await prisma.marketplaceImport.findUnique({ where: { id: importId }, include: { changes: true } });
  if (!imp) throw new MarketplaceImportError("Batch impor tidak ditemukan");
  if (imp.undoneAt) throw new MarketplaceImportError("Batch ini sudah dibatalkan");
  const newer = await prisma.marketplaceImport.findFirst({ where: { storeId: imp.storeId, channel: imp.channel, kind: imp.kind, undoneAt: null, createdAt: { gt: imp.createdAt } }, select: { fileName: true } });
  if (newer) throw new MarketplaceImportError(`Ada impor yang lebih baru (${newer.fileName}). Batalkan yang terbaru dulu agar data tidak tercampur.`);
  await prisma.$transaction(
    async (tx) => {
      const restored = imp.changes.length;
      for (const c of imp.changes) {
        const b = des(c.before as Record<string, unknown>);
        if (c.table === "ORDER") {
          const { lines, ...rest } = b as Record<string, unknown> & { lines: Record<string, unknown>[] };
          if (!(await tx.marketplaceOrder.findUnique({ where: { id: c.rowId }, select: { id: true } }))) continue;
          await tx.marketplaceOrder.update({ where: { id: c.rowId }, data: rest as Prisma.MarketplaceOrderUncheckedUpdateInput });
          await tx.marketplaceOrderLine.deleteMany({ where: { orderId: c.rowId } });
          await tx.marketplaceOrderLine.createMany({ data: (lines ?? []).map((l) => ({ ...(des(l) as object), orderId: c.rowId })) as Prisma.MarketplaceOrderLineCreateManyInput[] });
        } else if (await tx.marketplaceIncome.findUnique({ where: { id: c.rowId }, select: { id: true } })) {
          await tx.marketplaceIncome.update({ where: { id: c.rowId }, data: b as Prisma.MarketplaceIncomeUncheckedUpdateInput });
        }
      }
      void restored;
      // yang dibuat batch ini (pesanan → barisnya ikut terhapus; penghasilan → tautan pesanan kembali kosong)
      const dOrders = await tx.marketplaceOrder.deleteMany({ where: { importId } });
      const dIncome = await tx.marketplaceIncome.deleteMany({ where: { importId } });
      const dWd = await tx.marketplaceWithdrawal.deleteMany({ where: { importId } });
      await tx.marketplaceImport.update({ where: { id: importId }, data: { undoneAt: new Date(), undoneBy: actor.name, stats: { ...(imp.stats as object), dibatalkan: { pesanan: dOrders.count, penghasilan: dIncome.count, penarikan: dWd.count, dikembalikan: imp.changes.length } } } });
      await tx.marketplaceChange.deleteMany({ where: { importId } });
      await linkIncome(tx, imp.storeId, imp.channel);
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  await audit(actor, "MARKETPLACE_IMPOR_BATAL", "MarketplaceImport", importId, { file: imp.fileName });
}
