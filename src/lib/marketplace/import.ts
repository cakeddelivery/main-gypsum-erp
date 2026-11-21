import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "./parse";
import { CHANNEL_OF, incomeSig, lineKey, mapStatus, orderSig } from "./rules";
import { planOrderUpdate, type ExistingOrder } from "./merge";
import { resolveSkuKeys } from "./sku";
import { linkOrdersToReturns } from "./link";

/**
 * Impor penjualan marketplace. HANYA menulis ke tabel Marketplace* — tidak menyentuh stok, mutasi, jurnal, maupun transaksi.
 * Setiap file = satu batch (MarketplaceImport) yang bisa dibatalkan utuh.
 */
export class MarketplaceImportError extends Error {}

type Actor = { id: string; name: string };
export type ImportFile = { fileName: string; storeId: string; parsed: ParsedFile; /** sidik isi file (sha1) untuk mengenali unggahan ganda, mis. "(1)", "(2)" */ hash?: string };

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
  /** Rincian perubahan pada pesanan yang sudah ada, mis. {"Dikirim → Selesai": 120, "resi baru": 15, "Piutang → Cair": 340} */
  changes: Record<string, number>;
  /** Keterangan tambahan (mis. ringkasan Saldo Penjual) */
  note?: string;
  /** Sheet dibaca / dilewati (dengan alasan) dan kolom yang sengaja tidak disimpan (data pribadi) */
  sheets?: { read: string[]; skipped: { name: string; reason: string }[] };
  personalCols?: string[];
  /** Data tambahan dari sheet lain: selisih ongkir & Seller Fee (jumlah baris, yang baru) */
  extras?: { shipDisc: number; shipDiscBaru: number; sellerFee: number; sellerFeeBaru: number };
  /** Galat yang menahan penyimpanan (mis. toko tidak cocok dengan file) */
  error?: string;
};
export type Preview = { files: FilePreview[]; totals: { baru: number; diperbarui: number; dilewati: number; perluDicek: number } };

const chunk = <T>(a: T[], n = 3000) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

const sellerKey = (storeId: string, channel: string) => `marketplace_seller:${storeId}:${channel}`;
const normSeller = (x: string) => x.trim().toLowerCase().replace(/\s+/g, "");

/**
 * Pengaman salah toko: (1) username/nama toko di file harus sama dengan yang pernah dipakai untuk toko+kanal ini
 * (pertama kali dikonfirmasi lewat impor pertama); (2) pesanan yang sudah tercatat di toko LAIN berarti salah pilih toko.
 */
async function storeGuards(db: Tx | typeof prisma, f: ImportFile, channel: string): Promise<{ error?: string; remember?: string; info?: string }> {
  const seller = f.parsed.info.seller?.trim();
  let remember: string | undefined, info: string | undefined;
  if (f.parsed.kind !== "ORDER" && seller) {
    const stored = (await db.setting.findUnique({ where: { key: sellerKey(f.storeId, channel) } }))?.value;
    if (stored && stored !== normSeller(seller)) {
      const st = await db.store.findUnique({ where: { id: f.storeId }, select: { name: true } });
      return { error: `Penjual di file (“${seller}”) berbeda dengan penjual yang pernah diimpor untuk ${st?.name ?? "toko ini"} (“${stored}”). Periksa pilihan toko — jangan sampai data toko lain tercampur.` };
    }
    if (!stored) { remember = normSeller(seller); info = `Penjual “${seller}” akan disimpan untuk toko ini; impor berikutnya dicek terhadap nama ini.`; }
  }
  const nos = f.parsed.kind === "ORDER" ? f.parsed.orders.map((o) => o.orderNo) : f.parsed.incomes.filter((i) => i.kind === "ORDER").map((i) => i.refNo);
  let elsewhere = 0;
  let where = "";
  for (const part of chunk(nos)) {
    const rows = await db.marketplaceOrder.findMany({ where: { channel, orderNo: { in: part }, storeId: { not: f.storeId } }, select: { orderNo: true, storeId: true }, take: 50 });
    elsewhere += rows.length;
    if (rows.length && !where) where = (await db.store.findUnique({ where: { id: rows[0].storeId }, select: { name: true } }))?.name ?? "toko lain";
  }
  if (elsewhere) return { error: `${elsewhere}${elsewhere >= 50 ? "+" : ""} pesanan di file ini sudah tercatat di ${where}. Kemungkinan salah memilih toko — impor ditahan agar data tidak dobel/tercampur.` };
  return { remember, info };
}

async function checkStore(storeId: string) {
  const s = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, code: true } });
  if (!s) throw new MarketplaceImportError("Pilih toko untuk setiap file");
  return s;
}

export async function previewImport(files: ImportFile[], opts: { ordersInBatch?: boolean } = {}): Promise<Preview> {
  if (!files.length) throw new MarketplaceImportError("Pilih minimal satu file");
  const out: FilePreview[] = [];
  // pesanan yang ikut diunggah bersamaan (agar penghasilan tidak dianggap "tanpa order")
  const inUpload = new Set<string>();
  for (const f of files) if (f.parsed.kind === "ORDER") for (const o of f.parsed.orders) inUpload.add(`${f.storeId}|${CHANNEL_OF[f.parsed.platform]}|${o.orderNo}`);
  for (const f of files) {
    const store = await checkStore(f.storeId);
    const channel = CHANNEL_OF[f.parsed.platform];
    const p: FilePreview = {
      fileName: f.fileName, storeName: store.name, platform: f.parsed.platform, kind: f.parsed.kind, channel, periodFrom: f.parsed.periodFrom, periodTo: f.parsed.periodTo, seller: f.parsed.info.seller, note: f.parsed.info.note, sheets: f.parsed.info.sheets, personalCols: f.parsed.info.personalCols,
      total: 0, baru: 0, diperbarui: 0, dilewati: 0, withdrawals: 0, adsRows: 0, unmapped: [], incomeNoOrder: 0, changes: {},
    };
    const g = await storeGuards(prisma, f, channel);
    if (g.error) p.error = g.error;
    if (g.info) p.note = [p.note, g.info].filter(Boolean).join(" ");
    if (f.parsed.kind === "ORDER") {
      const orders = f.parsed.orders;
      p.total = orders.length;
      const exist = await loadExisting(prisma, f.storeId, channel, orders.map((o) => o.orderNo));
      for (const o of orders) {
        const ex = exist.get(o.orderNo);
        if (!ex) {
          p.baru++;
          continue;
        }
        const plan = planOrderUpdate(ex.row, o, channel);
        if (!plan.changes.length && !Object.keys(plan.data).length && !plan.replaceLines) p.dilewati++;
        else {
          p.diperbarui++;
          for (const c of plan.changes) p.changes[c] = (p.changes[c] ?? 0) + 1;
        }
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
      // Setiap baris penyelesaian = satu event; baris yang sudah ada dilewati, baris baru (mis. refund setelah cair) ditambahkan
      const plan = await planIncome(prisma, f.storeId, channel, rows);
      for (const g of plan.groups) {
        p.dilewati += g.skip;
        if (g.isNew) p.baru += g.fresh.length;
        else p.diperbarui += g.fresh.length;
        if (!g.isNew && g.fresh.length) p.changes["baris penyelesaian tambahan"] = (p.changes["baris penyelesaian tambahan"] ?? 0) + g.fresh.length;
      }
      if (f.parsed.kind === "BALANCE") {
        // Buku Saldo: yang dihitung = mutasi saldo (baris), bukan event turunan
        const txs = f.parsed.balanceTx ?? [];
        const have = new Set<string>();
        for (const part of chunk(txs.map((t) => t.txKey))) for (const e of await prisma.marketplaceBalanceTx.findMany({ where: { storeId: f.storeId, channel, txKey: { in: part } }, select: { txKey: true } })) have.add(e.txKey);
        p.total = txs.length;
        p.baru = txs.filter((t) => !have.has(t.txKey)).length;
        p.dilewati = txs.length - p.baru;
        p.diperbarui = 0;
        p.withdrawals = f.parsed.withdrawals.length;
        p.adsRows = 0;
      }
      const orderRefs = rows.filter((r) => r.kind === "ORDER").map((r) => r.refNo);
      const have = new Set<string>();
      for (const part of chunk(orderRefs)) for (const e of await prisma.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } }, select: { orderNo: true } })) have.add(e.orderNo);
      const sd = f.parsed.shipDiscrepancies ?? [], sf = f.parsed.sellerFees ?? [];
      if (sd.length || sf.length) {
        const haveD = new Set<string>(), haveF = new Set<string>();
        for (const part of chunk(sd.map((x) => x.orderNo))) for (const e of await prisma.marketplaceShipDiscrepancy.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } }, select: { orderNo: true } })) haveD.add(e.orderNo);
        for (const part of chunk(sf.map((x) => x.orderNo))) for (const e of await prisma.marketplaceSellerFee.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part } }, select: { orderNo: true } })) haveF.add(e.orderNo);
        p.extras = { shipDisc: sd.length, shipDiscBaru: sd.filter((x) => !haveD.has(x.orderNo)).length, sellerFee: sf.length, sellerFeeBaru: sf.filter((x) => !haveF.has(x.orderNo)).length };
      }
      p.incomeNoOrder = opts.ordersInBatch ? 0 : orderRefs.filter((r) => !have.has(r) && !inUpload.has(`${f.storeId}|${channel}|${r}`)).length;
      let cair = 0;
      for (const part of chunk(orderRefs)) cair += await prisma.marketplaceOrder.count({ where: { storeId: f.storeId, channel, orderNo: { in: part }, incomeId: null, status: { not: "BATAL" } } });
      if (cair) p.changes["Piutang → Cair"] = cair;
    }
    out.push(p);
  }
  const sum = (k: "baru" | "diperbarui" | "dilewati") => out.reduce((a, f) => a + f[k], 0);
  return { files: out, totals: { baru: sum("baru"), diperbarui: sum("diperbarui"), dilewati: sum("dilewati"), perluDicek: out.reduce((a, f) => a + f.unmapped.length + (f.incomeNoOrder ? 1 : 0) + (f.error ? 1 : 0), 0) } };
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
  sig: orderSig(o, status), lastImportId: importId, ...(o.extra?.length ? { extra: o.extra as Prisma.InputJsonValue } : {}),
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

type ExistingRow = { id: string; row: ExistingOrder };
/** Muat pesanan yang sudah ada (beserta isi & status pencairan) untuk dibandingkan */
async function loadExisting(db: Tx | typeof prisma, storeId: string, channel: string, orderNos: string[]) {
  const out = new Map<string, ExistingRow>();
  for (const part of chunk(orderNos)) {
    for (const e of await db.marketplaceOrder.findMany({ where: { storeId, channel, orderNo: { in: part } }, include: { lines: true } })) {
      out.set(e.orderNo, { id: e.id, row: { ...e, hasIncome: !!e.incomeId } });
    }
  }
  return out;
}

async function commitOrders(tx: Tx, f: ImportFile, channel: string, importId: string) {
  const orders = f.parsed.orders;
  const exist = await loadExisting(tx, f.storeId, channel, orders.map((o) => o.orderNo));
  const news: ParsedOrder[] = [];
  let upd = 0, skip = 0;
  for (const o of orders) {
    const e = exist.get(o.orderNo);
    if (!e) {
      news.push(o);
      continue;
    }
    const plan = planOrderUpdate(e.row, o, channel);
    if (!plan.changes.length && !Object.keys(plan.data).length && !plan.replaceLines) {
      skip++;
      continue;
    }
    const before = await tx.marketplaceOrder.findUniqueOrThrow({ where: { id: e.id }, include: { lines: true } });
    const keys = [...SCALAR_O, "affiliate", "needsCheck"] as const;
    await tx.marketplaceChange.create({ data: { importId, table: "ORDER", rowId: e.id, summary: plan.changes.join("; ") || "data dilengkapi", before: { ...ser(before as unknown as Record<string, unknown>, keys), lines: before.lines.map((l) => ({ ...ser(l as unknown as Record<string, unknown>, ["id", "sku", "variation", "skuKey", "name", "qty", "unitPrice", "amount", "returnQty", "sortOrder"]) })) } as Prisma.InputJsonValue } });
    await tx.marketplaceOrder.update({ where: { id: e.id }, data: { ...(plan.data as Prisma.MarketplaceOrderUncheckedUpdateInput), lastImportId: importId, sig: orderSig(o, plan.status) } });
    if (plan.replaceLines) {
      await tx.marketplaceOrderLine.deleteMany({ where: { orderId: e.id } });
      await tx.marketplaceOrderLine.createMany({ data: lineRows(e.id, channel, o) });
    }
    upd++;
  }
  // Pesanan lama yang belum punya kolom lengkap (diimpor sebelum fitur ini): lengkapi saja, tanpa mengubah status/angka
  const withExtra = orders.filter((o) => o.extra?.length && exist.has(o.orderNo));
  for (const part of chunk(withExtra, 500)) {
    const need = await tx.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part.map((o) => o.orderNo) }, extra: { equals: Prisma.DbNull } }, select: { id: true, orderNo: true } });
    const byNo = new Map(part.map((o) => [o.orderNo, o]));
    for (const n of need) await tx.marketplaceOrder.update({ where: { id: n.id }, data: { extra: byNo.get(n.orderNo)!.extra as Prisma.InputJsonValue } });
  }
  for (const part of chunk(news, 500)) {
    const ids = part.map(() => randomUUID());
    await tx.marketplaceOrder.createMany({ data: part.map((o, i) => ({ id: ids[i], storeId: f.storeId, channel, orderNo: o.orderNo, importId, affiliate: o.affiliate, ...orderData(o, mapStatus(channel, o), importId) })) });
    await tx.marketplaceOrderLine.createMany({ data: part.flatMap((o, i) => lineRows(ids[i], channel, o)) });
  }
  return { baru: news.length, diperbarui: upd, dilewati: skip };
}

type IncGroup = { kind: string; refNo: string; incomeId: string | null; isNew: boolean; hasLegacy: boolean; all: (ParsedIncome & { key: string })[]; fresh: (ParsedIncome & { key: string })[]; skip: number };

/** Kunci stabil baris penyelesaian: hash isi (+ nomor urut bila ada baris kembar persis di satu file) */
export function eventKeys(rows: ParsedIncome[]) {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = createHash("sha1").update(`${r.kind}|${r.refNo}|${r.releasedAt?.toISOString() ?? ""}|${r.released}|${r.productAmt}|${r.refundAmt}|${r.fees}`).digest("hex").slice(0, 16);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...r, key: n > 1 ? `${base}#${n}` : base };
  });
}

/** Kelompokkan baris file per pesanan & tandai event yang sudah ada / baru (tanpa menulis) */
export async function planIncome(db: Tx | typeof prisma, storeId: string, channel: string, rows: ParsedIncome[]) {
  const evs = eventKeys(rows);
  const byRef = new Map<string, (ParsedIncome & { key: string })[]>();
  for (const e of evs) byRef.set(`${e.kind}|${e.refNo}`, [...(byRef.get(`${e.kind}|${e.refNo}`) ?? []), e]);
  const exist = new Map<string, { id: string; keys: Set<string> }>();
  for (const part of chunk([...new Set(rows.map((r) => r.refNo))])) {
    for (const e of await db.marketplaceIncome.findMany({ where: { storeId, channel, refNo: { in: part } }, select: { id: true, kind: true, refNo: true, events: { select: { eventKey: true } } } })) exist.set(`${e.kind}|${e.refNo}`, { id: e.id, keys: new Set(e.events.map((x) => x.eventKey)) });
  }
  const groups: IncGroup[] = [];
  for (const [k, all] of byRef) {
    const ex = exist.get(k);
    const keys = ex?.keys ?? new Set<string>();
    const hasLegacy = keys.has("legacy");
    const fresh = all.filter((e) => !keys.has(e.key));
    groups.push({ kind: all[0].kind, refNo: all[0].refNo, incomeId: ex?.id ?? null, isNew: !ex, hasLegacy, all, fresh, skip: all.length - fresh.length });
  }
  return { evs, groups };
}

/** Hitung ulang angka gabungan per pesanan dari semua event-nya (cair = Σ event); hapus penghasilan tanpa event */
export async function recomputeIncomes(tx: Tx, incomeIds: string[]) {
  for (const part of chunk(incomeIds, 500)) {
    const evs = await tx.marketplaceIncomeEvent.findMany({ where: { incomeId: { in: part } }, orderBy: { releasedAt: "asc" } });
    const by = new Map<string, typeof evs>();
    for (const e of evs) by.set(e.incomeId, [...(by.get(e.incomeId) ?? []), e]);
    for (const id of part) {
      const list = by.get(id) ?? [];
      if (!list.length) {
        await tx.marketplaceIncome.delete({ where: { id } }); // pesanan.incomeId otomatis kosong (SetNull)
        continue;
      }
      const detail: Record<string, number> = {};
      for (const e of list) for (const [k, v] of Object.entries((e.feeDetail ?? {}) as Record<string, number>)) detail[k] = (detail[k] ?? 0) + v;
      const dates = list.map((e) => e.releasedAt?.getTime()).filter((x): x is number => !!x);
      await tx.marketplaceIncome.update({
        where: { id },
        data: {
          released: list.reduce((a, e) => a + e.released, 0n), productAmt: list.reduce((a, e) => a + e.productAmt, 0n), refundAmt: list.reduce((a, e) => a + e.refundAmt, 0n), fees: list.reduce((a, e) => a + e.fees, 0n),
          feeDetail: detail as Prisma.InputJsonValue, releasedAt: dates.length ? new Date(Math.max(...dates)) : null, sig: createHash("sha1").update(list.map((e) => e.eventKey).sort().join("|")).digest("hex").slice(0, 20),
        },
      });
    }
  }
}

async function commitIncome(tx: Tx, f: ImportFile, channel: string, importId: string) {
  const { groups } = await planIncome(tx, f.storeId, channel, f.parsed.incomes);
  let baru = 0, upd = 0, skip = 0;
  const touched: string[] = [];
  const newIncomes: { id: string; g: IncGroup }[] = [];
  for (const g of groups) {
    skip += g.skip;
    if (!g.fresh.length) continue;
    if (g.isNew) {
      newIncomes.push({ id: randomUUID(), g });
      baru += g.fresh.length;
    } else {
      upd += g.fresh.length;
      touched.push(g.incomeId!);
    }
  }
  for (const part of chunk(newIncomes, 1000)) {
    await tx.marketplaceIncome.createMany({ data: part.map(({ id, g }) => ({ id, storeId: f.storeId, channel, kind: g.kind, refNo: g.refNo, importId, orderedAt: g.all[0].orderedAt, lastImportId: importId })) });
    touched.push(...part.map((x) => x.id));
  }
  const evRows: Prisma.MarketplaceIncomeEventCreateManyInput[] = [];
  const legacyOf: string[] = [];
  for (const g of groups) {
    if (!g.fresh.length) continue;
    const incomeId = g.incomeId ?? newIncomes.find((x) => x.g === g)!.id;
    if (g.hasLegacy) legacyOf.push(incomeId); // hasil impor lama digantikan oleh baris-baris file ini
    for (const e of g.fresh) evRows.push({ incomeId, eventKey: e.key, releasedAt: e.releasedAt, released: BigInt(e.released), productAmt: BigInt(e.productAmt), refundAmt: BigInt(e.refundAmt), fees: BigInt(e.fees), feeDetail: e.feeDetail as Prisma.InputJsonValue, importId });
  }
  if (legacyOf.length) await tx.marketplaceIncomeEvent.deleteMany({ where: { incomeId: { in: legacyOf }, eventKey: "legacy" } });
  for (const part of chunk(evRows, 1000)) await tx.marketplaceIncomeEvent.createMany({ data: part });
  await recomputeIncomes(tx, [...new Set(touched)]);
  // Pesanan yang belum cair dan baru ketemu penghasilannya: catat riwayat "Piutang → Cair"
  const refs = f.parsed.incomes.filter((r) => r.kind === "ORDER").map((r) => r.refNo);
  const waiting: { id: string; orderNo: string }[] = [];
  for (const part of chunk(refs)) waiting.push(...(await tx.marketplaceOrder.findMany({ where: { storeId: f.storeId, channel, orderNo: { in: part }, incomeId: null, status: { not: "BATAL" } }, select: { id: true, orderNo: true } })));
  if (waiting.length) {
    await linkIncome(tx, f.storeId, channel);
    const linked = await tx.marketplaceOrder.findMany({ where: { id: { in: waiting.map((w) => w.id) }, incomeId: { not: null } }, select: { id: true } });
    if (linked.length) await tx.marketplaceChange.createMany({ data: linked.map((o) => ({ importId, table: "LINK", rowId: o.id, summary: "Piutang → Cair", before: {} })) });
  }
  await flagRefundAfterPaid(tx, f.storeId, channel);
  let wd = 0;
  const wrows = f.parsed.withdrawals;
  if (wrows.length) {
    const res = await tx.marketplaceWithdrawal.createMany({ data: wrows.map((w) => ({ storeId: f.storeId, channel, txType: w.txType, refId: w.refId, requestedAt: w.requestedAt, doneAt: w.doneAt, amount: BigInt(w.amount), status: w.status, importId })), skipDuplicates: true });
    wd = res.count;
  }
  return { baru, diperbarui: upd, dilewati: skip, withdrawals: wd };
}

/** Pesanan yang sudah cair lalu direfund (jumlah penyelesaian ≤ 0): tandai "perlu dicek" agar dicocokkan dengan retur */
export async function flagRefundAfterPaid(tx: Tx | typeof prisma, storeId: string, channel: string) {
  await tx.$executeRaw`UPDATE "MarketplaceOrder" o SET "needsCheck" = 'REFUND_SETELAH_CAIR' FROM "MarketplaceIncome" i
    WHERE o."incomeId" = i."id" AND o."storeId" = ${storeId} AND o."channel" = ${channel} AND o."needsCheck" IS NULL AND o."status" = 'PIUTANG' AND i."released" <= 0
    AND EXISTS (SELECT 1 FROM "MarketplaceIncomeEvent" e WHERE e."incomeId" = i."id" AND e."released" > 0)`;
}

export async function commitImport(actor: Actor, files: ImportFile[], opts: { finalize?: boolean } = {}) {
  if (!files.length) throw new MarketplaceImportError("Pilih minimal satu file");
  const results: { importId: string; fileName: string; baru: number; diperbarui: number; dilewati: number }[] = [];
  // pesanan dulu, penghasilan sesudahnya (tautan terisi otomatis di akhir)
  const sorted = [...files].sort((a, b) => (a.parsed.kind === b.parsed.kind ? 0 : a.parsed.kind === "ORDER" ? -1 : 1));
  for (const f of sorted) {
    await checkStore(f.storeId);
    const channel = CHANNEL_OF[f.parsed.platform];
    const guard = await storeGuards(prisma, f, channel);
    if (guard.error) throw new MarketplaceImportError(`${f.fileName}: ${guard.error}`);
    const r = await prisma.$transaction(
      async (tx) => {
        const imp = await tx.marketplaceImport.create({ data: { createdBy: actor.name, storeId: f.storeId, channel, kind: f.parsed.kind, fileName: f.fileName.slice(0, 200), periodFrom: f.parsed.periodFrom, periodTo: f.parsed.periodTo } });
        let stats: { baru: number; diperbarui: number; dilewati: number; withdrawals?: number } = f.parsed.kind === "ORDER" ? await commitOrders(tx, f, channel, imp.id) : await commitIncome(tx, f, channel, imp.id);
        if (f.parsed.kind === "BALANCE") {
          // Buku Saldo Penjual: simpan setiap mutasi (idempoten per kunci); hitungan batch = mutasi baru
          const txs = f.parsed.balanceTx ?? [];
          let made = 0;
          for (const part of chunk(txs, 1000)) made += (await tx.marketplaceBalanceTx.createMany({ data: part.map((t) => ({ storeId: f.storeId, channel, txKey: t.txKey, date: t.date, type: t.type, description: t.description, orderNo: t.orderNo, amount: BigInt(t.amount), status: t.status, balanceAfter: t.balanceAfter === null ? null : BigInt(t.balanceAfter), pos: t.pos, category: t.category, importId: imp.id })), skipDuplicates: true })).count;
          stats = { baru: made, diperbarui: 0, dilewati: txs.length - made, withdrawals: stats.withdrawals ?? 0 };
        }
        // Selisih ongkir & Seller Fee (sheet lain di file Penghasilan Shopee): hanya yang baru
        let extraMade = 0;
        const sd = f.parsed.shipDiscrepancies ?? [], sf = f.parsed.sellerFees ?? [];
        for (const part of chunk(sd, 1000)) extraMade += (await tx.marketplaceShipDiscrepancy.createMany({ data: part.map((x) => ({ storeId: f.storeId, channel, orderNo: x.orderNo, estimate: BigInt(x.estimate), paid: BigInt(x.paid), diff: BigInt(x.diff), reason: x.reason, date: x.date, importId: imp.id })), skipDuplicates: true })).count;
        for (const part of chunk(sf, 1000)) extraMade += (await tx.marketplaceSellerFee.createMany({ data: part.map((x) => ({ storeId: f.storeId, channel, orderNo: x.orderNo, platformFee: BigInt(x.platformFee), xtra: BigInt(x.xtra), service: BigInt(x.service), promo: BigInt(x.promo), other: BigInt(x.other), importId: imp.id })), skipDuplicates: true })).count;
        // Impor ulang yang identik tidak meninggalkan batch kosong (tidak ada yang perlu dibatalkan)
        if (!stats.baru && !stats.diperbarui && !extraMade && !("withdrawals" in stats && stats.withdrawals)) {
          await tx.marketplaceImport.delete({ where: { id: imp.id } });
          return { importId: "", fileName: f.fileName, ...stats };
        }
        // Angka pembanding untuk cek integritas: Σ cair baris ORDER di file vs total ringkasan file
        // Ringkasan TikTok = Σ SEMUA baris Detail pesanan (pesanan + iklan GMV + penyesuaian); Shopee "Total Penghasilan" = baris Order saja
        const fileTotal = f.parsed.incomes.filter((i) => f.parsed.platform === "TIKTOK" || i.kind === "ORDER").reduce((a, i) => a + i.released, 0);
        const extra = { total: f.parsed.kind === "ORDER" ? f.parsed.orders.length : f.parsed.kind === "BALANCE" ? (f.parsed.balanceTx?.length ?? 0) : f.parsed.incomes.length, lines: f.parsed.orders.reduce((a, o) => a + o.lines.length, 0), ...(f.parsed.kind !== "ORDER" ? { fileTotal, summaryTotal: f.parsed.info.summaryTotal ?? null, summaryLabel: f.parsed.info.summaryLabel ?? null, seller: f.parsed.info.seller ?? null, summaryRows: f.parsed.info.summaryRows ?? null, sheets: f.parsed.info.sheets ?? null, shipDisc: sd.length, sellerFee: sf.length } : {}) };
        await tx.marketplaceImport.update({ where: { id: imp.id }, data: { stats: { ...stats, ...extra, fileHash: f.hash ?? null } } });
        await linkIncome(tx, f.storeId, channel);
        if (guard.remember) await tx.setting.upsert({ where: { key: sellerKey(f.storeId, channel) }, create: { key: sellerKey(f.storeId, channel), value: guard.remember }, update: { value: guard.remember } });
        return { importId: imp.id, fileName: f.fileName, ...stats };
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    results.push(r);
  }
  if (opts.finalize !== false) await linkOrdersToReturns().catch(() => {}); // impor banyak file: dijalankan sekali di akhir batch
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
      for (const c of imp.changes) {
        if (c.table === "LINK") continue;
        const b = des(c.before as Record<string, unknown>);
        if (c.table === "ORDER") {
          const { lines, ...rest } = b as Record<string, unknown> & { lines: Record<string, unknown>[] };
          if (!(await tx.marketplaceOrder.findUnique({ where: { id: c.rowId }, select: { id: true } }))) continue;
          await tx.marketplaceOrder.update({ where: { id: c.rowId }, data: rest as Prisma.MarketplaceOrderUncheckedUpdateInput });
          await tx.marketplaceOrderLine.deleteMany({ where: { orderId: c.rowId } });
          await tx.marketplaceOrderLine.createMany({ data: (lines ?? []).map((l) => ({ ...(des(l) as object), orderId: c.rowId })) as Prisma.MarketplaceOrderLineCreateManyInput[] });
        }
      }
      // yang dibuat batch ini (pesanan → barisnya ikut terhapus; penghasilan → tautan pesanan kembali kosong)
      const dOrders = await tx.marketplaceOrder.deleteMany({ where: { importId } });
      // Penghasilan: buang event batch ini, hitung ulang angka gabungan (hapus bila tak ada event tersisa)
      const affected = (await tx.marketplaceIncomeEvent.findMany({ where: { importId }, select: { incomeId: true }, distinct: ["incomeId"] })).map((x) => x.incomeId);
      const dEv = await tx.marketplaceIncomeEvent.deleteMany({ where: { importId } });
      await recomputeIncomes(tx, affected);
      const dIncome = { count: dEv.count };
      const dWd = await tx.marketplaceWithdrawal.deleteMany({ where: { importId } });
      await tx.marketplaceBalanceTx.deleteMany({ where: { importId } });
      await tx.marketplaceShipDiscrepancy.deleteMany({ where: { importId } });
      await tx.marketplaceSellerFee.deleteMany({ where: { importId } });
      await tx.marketplaceImport.update({ where: { id: importId }, data: { undoneAt: new Date(), undoneBy: actor.name, stats: { ...(imp.stats as object), dibatalkan: { pesanan: dOrders.count, penghasilan: dIncome.count, penarikan: dWd.count, dikembalikan: imp.changes.length } } } });
      await tx.marketplaceChange.updateMany({ where: { importId }, data: { undone: true } }); // riwayat ringkas tetap ada
      await linkIncome(tx, imp.storeId, imp.channel);
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  await audit(actor, "MARKETPLACE_IMPOR_BATAL", "MarketplaceImport", importId, { file: imp.fileName });
}
