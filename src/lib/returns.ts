import type { Prisma, ReturnStatus } from "@prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { locationSettings, recordMovement, reverseMovementsByRef, StockError } from "./stock";
import { recipeMaterialCost } from "./hpp";
import { packComponents, pieceInspection, type PieceInput } from "./returnPieces";
import { autoLinkReturn } from "./marketplace/link";
import { skuKey, type CatalogEntry, type LabelLine } from "./returnLabel";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Sumber jurnal retur (hasil periksa & klaim cair). Klaim cair tampil sebagai baris tertaut di Transaksi. */
export const RETURN_SOURCE = "RETUR";
export const COA_RETUR_RUSAK = "6-1810";
export const COA_KLAIM = "4-9200";
export const CLAIM_CATEGORY = "Klaim Retur Marketplace";

export const RETURN_STATUS: Record<ReturnStatus, { label: string; tone: "gray" | "blue" | "amber" | "green" | "red" }> = {
  DITERIMA: { label: "Diterima", tone: "blue" },
  DIPERIKSA: { label: "Diperiksa", tone: "amber" },
  KLAIM_DIAJUKAN: { label: "Klaim diajukan", tone: "amber" },
  KLAIM_CAIR: { label: "Klaim cair", tone: "green" },
  KLAIM_DITOLAK: { label: "Klaim ditolak", tone: "red" },
  SELESAI: { label: "Selesai", tone: "green" },
};
export const returnStatusOf = (r: { status: ReturnStatus; cancelledAt?: Date | null }) => (r.cancelledAt ? { label: "Dibatalkan", tone: "gray" as const } : RETURN_STATUS[r.status]);

/** Pengaturan retur (Pengaturan → parameter) */
export const RETURN_SETTINGS = {
  videoMaxMinutes: { key: "retur_video_maks_menit", def: 10 },
  videoKeepDays: { key: "retur_video_hapus_hari", def: 60 },
  diskWarnPct: { key: "disk_peringatan_persen", def: 15 },
  staleDays: { key: "retur_menggantung_hari", def: 14 },
} as const;
export async function returnSetting(k: keyof typeof RETURN_SETTINGS, db: Pick<Tx, "setting"> = prisma) {
  const s = RETURN_SETTINGS[k];
  const row = await db.setting.findUnique({ where: { key: s.key } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : s.def;
}

export type ReturnLineInput = { labelSku?: string | null; labelVariation?: string | null; labelName?: string | null; qty: number; itemId?: string | null };
export type ReturnInput = {
  receivedAt: Date;
  marketplace?: string | null;
  courier?: string | null;
  trackingNo: string;
  orderNo?: string | null;
  city?: string | null;
  province?: string | null;
  reason?: string | null;
  note?: string | null;
  storeId?: string | null;
  labelRead?: Prisma.InputJsonValue | null;
  /// Ongkir retur ditanggung toko (opsional, untuk analitik)
  shippingCost?: number;
  lines: ReturnLineInput[];
};

const clean = (s: string | null | undefined, max = 120) => s?.trim().replace(/\s+/g, " ").slice(0, max) || null;
const normResi = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

/** Katalog barang jadi untuk pemetaan SKU label → ERP (SKU, nama produk, nama induk & pilihan varian) */
export async function returnCatalog(db: Tx | typeof prisma = prisma): Promise<CatalogEntry[]> {
  const items = await db.item.findMany({
    where: { active: true, type: "BARANG_JADI" },
    select: { id: true, sku: true, name: true, product: { select: { sku: true, name: true, family: { select: { name: true } }, variantValues: { select: { option: { select: { name: true } } } } } } },
    orderBy: { name: "asc" },
  });
  return items.map((i) => ({
    itemId: i.id,
    sku: i.product?.sku ?? i.sku,
    name: i.product?.name ?? i.name,
    words: [i.sku, i.name, i.product?.family?.name ?? "", ...(i.product?.variantValues.map((v) => v.option.name) ?? [])].filter(Boolean),
  }));
}

export async function skuMaps(db: Tx | typeof prisma = prisma) {
  return new Map((await db.marketplaceSkuMap.findMany()).map((m) => [m.key, m.itemId]));
}

function validLines(lines: ReturnLineInput[]) {
  const rows = lines.filter((l) => (l.labelSku?.trim() || l.labelName?.trim() || l.itemId) && l.qty > 0).map((l) => ({ ...l, qty: Math.round(l.qty) }));
  if (!rows.length) throw new StockError("Isi minimal satu barang di dalam paket");
  if (rows.some((l) => !(l.qty > 0 && l.qty < 100000))) throw new StockError("Jumlah barang tidak valid");
  return rows;
}

async function checkItems(tx: Tx, rows: ReturnLineInput[]) {
  const ids = [...new Set(rows.map((l) => l.itemId).filter(Boolean) as string[])];
  const items = await tx.item.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, name: true } });
  for (const id of ids) {
    const it = items.find((i) => i.id === id);
    if (!it) throw new StockError("Barang tidak ditemukan");
    if (it.type !== "BARANG_JADI") throw new StockError(`${it.name} bukan produk jadi`);
  }
}

/** Simpan pemetaan SKU yang dikonfirmasi pengguna agar retur berikutnya langsung terpetakan */
async function learnMaps(tx: Tx, rows: ReturnLineInput[], actor: Actor) {
  for (const l of rows) {
    if (!l.itemId || !l.labelSku?.trim()) continue;
    const key = skuKey(l.labelSku, l.labelVariation);
    await tx.marketplaceSkuMap.upsert({ where: { key }, create: { key, itemId: l.itemId, updatedBy: actor.name }, update: { itemId: l.itemId, updatedBy: actor.name } });
  }
}

/** Catat paket retur yang diterima (status Diterima). Satu no. resi hanya boleh satu retur aktif. */
export async function createReturn(input: ReturnInput, actor: Actor) {
  const trackingNo = normResi(input.trackingNo ?? "");
  if (trackingNo.length < 6) throw new StockError("No. resi wajib diisi (scan barcode label atau ketik manual)");
  const rows = validLines(input.lines);
  return prisma.$transaction(async (tx) => {
    const same = await tx.returnCase.findFirst({ where: { trackingNo, cancelledAt: null }, select: { number: true } });
    if (same) throw new StockError(`Resi ${trackingNo} sudah tercatat di ${same.number}`);
    await checkItems(tx, rows);
    const number = await nextNumber(tx, "RTR", input.receivedAt);
    const r = await tx.returnCase.create({
      data: {
        number, receivedAt: input.receivedAt, marketplace: clean(input.marketplace, 20), courier: clean(input.courier, 30), trackingNo, orderNo: clean(input.orderNo, 40)?.toUpperCase() ?? null,
        city: clean(input.city, 60), province: clean(input.province, 60), reason: clean(input.reason, 200), note: clean(input.note, 500), shippingCost: BigInt(Math.max(0, Math.round(input.shippingCost ?? 0))), storeId: input.storeId ?? null,
        labelRead: input.labelRead ?? undefined, createdBy: actor.name, createdById: actor.id,
        lines: { create: rows.map((l, i) => ({ labelSku: clean(l.labelSku, 40)?.toUpperCase() ?? null, labelVariation: clean(l.labelVariation, 60)?.toUpperCase() ?? null, labelName: clean(l.labelName, 80), qty: l.qty, itemId: l.itemId || null, sortOrder: i })) },
      },
    });
    await learnMaps(tx, rows, actor);
    await audit(actor, "RETUR_DIBUAT", "ReturnCase", r.id, { number, trackingNo, lines: rows.length }, tx);
    return r;
  }).then(async (r) => {
    await autoLinkReturn("RETUR", r.id); // cocokkan ke pesanan marketplace (resi/no. pesanan); gagal diam-diam
    return r;
  });
}

/** Ubah data retur yang belum diperiksa (salah baca label, barang belum dipetakan) */
export async function updateReturn(id: string, input: ReturnInput, actor: Actor) {
  const trackingNo = normResi(input.trackingNo ?? "");
  if (trackingNo.length < 6) throw new StockError("No. resi wajib diisi");
  const rows = validLines(input.lines);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReturnCase" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.returnCase.findUniqueOrThrow({ where: { id } });
    if (cur.cancelledAt) throw new StockError(`${cur.number} sudah dibatalkan`);
    if (cur.status !== "DITERIMA") throw new StockError(`${cur.number} sudah diperiksa; data barang tidak bisa diubah lagi`);
    const same = await tx.returnCase.findFirst({ where: { trackingNo, cancelledAt: null, id: { not: id } }, select: { number: true } });
    if (same) throw new StockError(`Resi ${trackingNo} sudah tercatat di ${same.number}`);
    await checkItems(tx, rows);
    await tx.returnLine.deleteMany({ where: { returnId: id } });
    const r = await tx.returnCase.update({
      where: { id },
      data: {
        receivedAt: input.receivedAt, marketplace: clean(input.marketplace, 20), courier: clean(input.courier, 30), trackingNo, orderNo: clean(input.orderNo, 40)?.toUpperCase() ?? null,
        city: clean(input.city, 60), province: clean(input.province, 60), reason: clean(input.reason, 200), note: clean(input.note, 500), shippingCost: BigInt(Math.max(0, Math.round(input.shippingCost ?? 0))),
        lines: { create: rows.map((l, i) => ({ labelSku: clean(l.labelSku, 40)?.toUpperCase() ?? null, labelVariation: clean(l.labelVariation, 60)?.toUpperCase() ?? null, labelName: clean(l.labelName, 80), qty: l.qty, itemId: l.itemId || null, sortOrder: i })) },
      },
    });
    await learnMaps(tx, rows, actor);
    await audit(actor, "RETUR_DIUBAH", "ReturnCase", id, { number: cur.number }, tx);
    return r;
  });
}

export type InspectRow = { lineId: string; goodQty: number; damagedQty: number; note?: string | null; /** Per pcs/karakter (paket Single Pack) */ pieces?: PieceInput[] };

/** Nilai hasil periksa (murni): barang baik kembali ke persediaan; rusak + tidak ada di paket = kerugian */
export function inspectionValues(lines: { qty: number; goodQty: number; damagedQty: number; unitCost: number }[]) {
  let good = 0;
  let loss = 0;
  for (const l of lines) {
    if (l.goodQty < 0 || l.damagedQty < 0 || !Number.isInteger(l.goodQty) || !Number.isInteger(l.damagedQty)) throw new StockError("Jumlah baik/rusak harus bilangan bulat ≥ 0");
    if (l.goodQty + l.damagedQty > l.qty) throw new StockError("Jumlah baik + rusak melebihi jumlah di label");
    good += l.goodQty * l.unitCost;
    loss += (l.qty - l.goodQty) * l.unitCost;
  }
  return { good: Math.round(good), loss: Math.round(loss) };
}

const reverseDate = (tx: Tx, date: Date, now: Date) => assertPeriodOpen(tx, date).then(() => date, () => now);

/** Balik hasil periksa sebelumnya (periksa ulang / batal): jurnal & mutasi stok barang baik */
async function undoInspection(tx: Tx, r: { number: string; inspectJournalId: string | null; inspectRef: string | null; inspectedAt: Date | null }, actor: Actor, why: string, now: Date) {
  if (r.inspectJournalId) await reverseJournal(tx, r.inspectJournalId, await reverseDate(tx, r.inspectedAt ?? now, now), actor, `${why} ${r.number}`.slice(0, 150));
  if (r.inspectRef) await reverseMovementsByRef(tx, r.inspectRef, `BATAL ${r.inspectRef}`, `${why} ${r.number}`, actor);
}

/**
 * Hasil periksa per barang. Jurnal (sumber RETUR):
 *  Dr Persediaan Barang Jadi (baik × harga pokok) + Dr Kerugian Barang Retur Rusak (rusak/hilang × harga pokok) / Cr HPP.
 * Barang retur dulu sudah keluar stok sebagai HPP (laporan shift packing / opname akhir bulan), jadi HPP dikoreksi —
 * tidak ada beban ganda. Barang baik masuk lagi ke gudang barang jadi. Bisa diperiksa ulang selama klaim belum diajukan.
 */
export async function inspectReturn(id: string, rows: InspectRow[], actor: Actor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReturnCase" WHERE id = ${id} FOR UPDATE`;
    const r = await tx.returnCase.findUniqueOrThrow({ where: { id }, include: { lines: { include: { item: true }, orderBy: { sortOrder: "asc" } } } });
    if (r.cancelledAt) throw new StockError(`${r.number} sudah dibatalkan`);
    if (r.status !== "DITERIMA" && r.status !== "DIPERIKSA") throw new StockError(`${r.number} sudah ${RETURN_STATUS[r.status].label.toLowerCase()}; hasil periksa tidak bisa diubah`);
    const missing = r.lines.filter((l) => !l.itemId);
    if (missing.length) throw new StockError(`Pilih barang ERP untuk: ${missing.map((l) => l.labelSku ?? l.labelName).join(", ")} (Ubah data retur)`);
    await assertPeriodOpen(tx, now);
    const { finished } = await locationSettings(tx);
    if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
    if (r.status === "DIPERIKSA") await undoInspection(tx, r, actor, "Periksa ulang", now);
    // Baris paket Single Pack diperiksa per pcs; selain itu per barang seperti biasa
    const wipLoc = (await locationSettings(tx)).wip ?? finished;
    const costOf = async (item: { id: string; avgCost: bigint | number }) => (Number(item.avgCost) > 0 ? Number(item.avgCost) : recipeMaterialCost(item.id));
    const comps = new Map(await Promise.all(r.lines.map(async (l) => [l.id, await packComponents(tx, l.itemId!)] as const)));
    const legacy = r.lines.filter((l) => !comps.get(l.id)!.length);
    const lines = await Promise.all(legacy.map(async (l) => {
      const row = rows.find((x) => x.lineId === l.id) ?? { lineId: l.id, goodQty: 0, damagedQty: 0 };
      const unitCost = await costOf(l.item!);
      return { l, row, unitCost, qty: l.qty, goodQty: Math.round(row.goodQty), damagedQty: Math.round(row.damagedQty) };
    }));
    const v = inspectionValues(lines);
    let goodBdp = 0;
    const gen = r.inspectRef ? Number(r.inspectRef.split("-P").pop()) + 1 || 2 : 1;
    const ref = `${r.number}-P${gen}`;
    for (const x of lines) {
      if (x.goodQty > 0) await recordMovement(tx, { type: "PENERIMAAN", itemId: x.l.itemId!, qty: x.goodQty, toLocationId: finished, unitCost: x.unitCost, ref, note: `Retur barang baik ${r.trackingNo}`, date: now }, actor);
      await tx.returnLine.update({ where: { id: x.l.id }, data: { goodQty: x.goodQty, damagedQty: x.damagedQty, unitCost: BigInt(Math.round(x.unitCost)), note: clean(x.row.note, 200), pieceMode: false, goodValue: 0n, lossValue: 0n } });
      await tx.returnPiece.deleteMany({ where: { lineId: x.l.id } });
    }
    for (const l of r.lines.filter((x) => comps.get(x.id)!.length)) {
      const cs = comps.get(l.id)!;
      const row = rows.find((x) => x.lineId === l.id);
      const items = await tx.item.findMany({ where: { id: { in: cs.map((c) => c.itemId) } }, select: { id: true, avgCost: true } });
      const detail = await Promise.all(cs.map(async (c) => {
        const given = row?.pieces?.find((p) => p.itemId === c.itemId);
        return { ...c, goodQty: given ? Math.round(given.goodQty) : c.perPack * l.qty, damagedQty: given ? Math.round(given.damagedQty) : 0, unitCost: await costOf(items.find((i) => i.id === c.itemId)!) };
      }));
      const pv = pieceInspection(l.qty, detail);
      let lineGood = pv.good;
      let unitCost = Math.round(pv.capPcs ? (pv.good + pv.loss) / pv.capPcs : 0);
      if (pv.allGood) {
        // Semua pcs baik: paket utuh kembali ke stok paket
        const packCost = await costOf(l.item!);
        await recordMovement(tx, { type: "PENERIMAAN", itemId: l.itemId!, qty: l.qty, toLocationId: finished, unitCost: packCost, ref, note: `Retur paket utuh ${r.trackingNo}`, date: now }, actor);
        lineGood = Math.round(packCost * l.qty);
        v.good += lineGood;
        unitCost = Math.round(packCost);
      } else {
        for (const d of detail) if (d.goodQty > 0) await recordMovement(tx, { type: "PENERIMAAN", itemId: d.itemId, qty: d.goodQty, toLocationId: wipLoc!, unitCost: d.unitCost, ref, note: `Retur pcs baik ${r.trackingNo}`, date: now }, actor);
        goodBdp += pv.good;
        v.good += pv.good;
        v.loss += pv.loss;
      }
      await tx.returnPiece.deleteMany({ where: { lineId: l.id } });
      await tx.returnPiece.createMany({ data: detail.map((d) => ({ lineId: l.id, itemId: d.itemId, perPack: d.perPack, goodQty: d.goodQty, damagedQty: d.damagedQty, unitCost: BigInt(Math.round(d.unitCost)) })) });
      await tx.returnLine.update({ where: { id: l.id }, data: { pieceMode: true, goodQty: pv.goodPcs, damagedQty: pv.damagedPcs, unitCost: BigInt(unitCost), goodValue: BigInt(lineGood), lossValue: BigInt(pv.allGood ? 0 : pv.loss), note: clean(row?.note, 200) } });
    }
    let journalId: string | null = null;
    if (v.good + v.loss > 0) {
      const jl: LineInput[] = [];
      if (v.good - goodBdp > 0) jl.push({ accountCode: COA.PERSEDIAAN_JADI, debit: v.good - goodBdp, memo: "Barang retur baik kembali ke gudang" });
      if (goodBdp > 0) jl.push({ accountCode: COA.PERSEDIAAN_BDP, debit: goodBdp, memo: "Single Pack retur baik kembali ke stok" });
      if (v.loss > 0) jl.push({ accountCode: COA_RETUR_RUSAK, debit: v.loss, memo: "Barang retur rusak / tidak ada di paket" });
      jl.push({ accountCode: COA.HPP, credit: v.good + v.loss, memo: "Koreksi HPP barang retur" });
      const j = await postJournal(tx, { date: now, storeId: r.storeId, description: `Hasil periksa retur ${r.number} resi ${r.trackingNo}`.slice(0, 150), source: RETURN_SOURCE, sourceId: `${r.number}:PERIKSA`, actor, lines: jl });
      journalId = j.id;
    }
    const out = await tx.returnCase.update({ where: { id }, data: { status: "DIPERIKSA", inspectedAt: now, inspectedBy: actor.name, inspectJournalId: journalId, inspectRef: ref, goodValue: BigInt(v.good), lossValue: BigInt(v.loss) } });
    await audit(actor, "RETUR_DIPERIKSA", "ReturnCase", id, { number: r.number, good: v.good, loss: v.loss, gen }, tx);
    return out;
  });
}

async function lockOpen(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "ReturnCase" WHERE id = ${id} FOR UPDATE`;
  const r = await tx.returnCase.findUniqueOrThrow({ where: { id } });
  if (r.cancelledAt) throw new StockError(`${r.number} sudah dibatalkan`);
  return r;
}

/** Ajukan klaim ke marketplace/kurir (nominal perkiraan) */
export async function submitClaim(id: string, amount: number, note: string | null, actor: Actor, now: Date = new Date()) {
  if (!(amount > 0)) throw new StockError("Isi nominal klaim");
  return prisma.$transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    if (r.status !== "DIPERIKSA" && r.status !== "KLAIM_DITOLAK") throw new StockError("Klaim diajukan setelah barang diperiksa");
    const out = await tx.returnCase.update({ where: { id }, data: { status: "KLAIM_DIAJUKAN", claimAmount: BigInt(Math.round(amount)), claimAt: now, claimNote: clean(note, 300), claimRejectedAt: null, claimRejectReason: null } });
    await audit(actor, "RETUR_KLAIM_DIAJUKAN", "ReturnCase", id, { number: r.number, amount }, tx);
    return out;
  });
}

/**
 * Klaim cair: Dr Rekening (mis. Saldo Penjual) / Cr Pendapatan Klaim Marketplace. Jurnal sumber RETUR otomatis
 * tampil sebagai baris tertaut (pemasukan, kategori Klaim Retur Marketplace) di menu Transaksi.
 */
export async function claimPaid(id: string, p: { amount: number; bankAccountId: string; date: Date; proofPath?: string | null; proofMime?: string | null }, actor: Actor) {
  const amount = Math.round(p.amount);
  if (!(amount > 0)) throw new StockError("Isi nominal klaim yang cair");
  if (!p.bankAccountId) throw new StockError("Pilih rekening tempat uang klaim masuk");
  return prisma.$transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    if (r.status !== "KLAIM_DIAJUKAN") throw new StockError("Klaim belum diajukan");
    await assertPeriodOpen(tx, p.date);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: p.bankAccountId } });
    const j = await postJournal(tx, {
      date: p.date, storeId: r.storeId, description: `Klaim retur cair ${r.number} resi ${r.trackingNo}`.slice(0, 150), source: RETURN_SOURCE, sourceId: `${r.number}:KLAIM`, actor,
      lines: [{ accountId: bank.coaAccountId, debit: amount, memo: "Klaim retur cair" }, { accountCode: COA_KLAIM, credit: amount, memo: r.marketplace ?? "Klaim" }],
    });
    const cat = await tx.txCategory.findFirst({ where: { name: CLAIM_CATEGORY } });
    await tx.financeTransaction.updateMany({ where: { journalId: j.id, origin: RETURN_SOURCE }, data: { ...(cat ? { categoryId: cat.id } : {}), ...(p.proofPath ? { proofPath: p.proofPath, proofMime: p.proofMime ?? null } : {}), counterparty: r.marketplace ?? null } });
    const out = await tx.returnCase.update({ where: { id }, data: { status: "KLAIM_CAIR", claimPaidAmount: BigInt(amount), claimPaidAt: p.date, claimBankAccountId: bank.id, claimJournalId: j.id } });
    await audit(actor, "RETUR_KLAIM_CAIR", "ReturnCase", id, { number: r.number, amount, bank: bank.name }, tx);
    return out;
  });
}

export async function claimRejected(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan klaim ditolak wajib diisi");
  return prisma.$transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    if (r.status !== "KLAIM_DIAJUKAN") throw new StockError("Klaim belum diajukan");
    const out = await tx.returnCase.update({ where: { id }, data: { status: "KLAIM_DITOLAK", claimRejectedAt: now, claimRejectReason: reason.trim().slice(0, 300) } });
    await audit(actor, "RETUR_KLAIM_DITOLAK", "ReturnCase", id, { number: r.number, reason }, tx);
    return out;
  });
}

/** Selesai: semua urusan retur beres. Video dihapus otomatis N hari sesudahnya (thumbnail & potongan gambar tetap). */
export async function finishReturn(id: string, actor: Actor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    if (!["DIPERIKSA", "KLAIM_CAIR", "KLAIM_DITOLAK"].includes(r.status)) throw new StockError(r.status === "DITERIMA" ? "Periksa barangnya dulu" : r.status === "SELESAI" ? `${r.number} sudah selesai` : "Tunggu klaim cair / ditolak dulu");
    const out = await tx.returnCase.update({ where: { id }, data: { status: "SELESAI", doneAt: now, doneBy: actor.name } });
    await audit(actor, "RETUR_SELESAI", "ReturnCase", id, { number: r.number }, tx);
    return out;
  });
}

/** Batalkan retur salah input: jurnal periksa & klaim dibalik, barang baik keluar lagi dari gudang. */
export async function cancelReturn(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    const why = "Batal retur";
    if (r.claimJournalId) await reverseJournal(tx, r.claimJournalId, await reverseDate(tx, r.claimPaidAt ?? now, now), actor, `${why} ${r.number} — ${reason.trim()}`.slice(0, 150));
    await undoInspection(tx, r, actor, why, now);
    const out = await tx.returnCase.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await audit(actor, "RETUR_DIBATALKAN", "ReturnCase", id, { number: r.number, reason }, tx);
    return out;
  });
}

/** Baris label → baris form (dengan pemetaan barang bila yakin) */
export function labelLinesToInput(lines: LabelLine[], match: (l: LabelLine) => string | null): ReturnLineInput[] {
  return lines.map((l) => ({ labelSku: l.sku, labelVariation: l.variation, labelName: l.name, qty: l.qty, itemId: match(l) }));
}
