import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { defaultStoreId, postJournal, reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { INVENTORY_COA, StockError, locationSettings, qtyAt, recordMovement, reverseMovementsByRef } from "./stock";
import { bomStockQty } from "./unitcost";
import { applyOwnOverhead, overheadCreditLines } from "./overheadFullCost";

/**
 * PRODUKSI WORKSHOP (tanpa borongan): setengah jadi (mis. Cat Plastik Merah/Biru/Kuning, Cat Giftbox) dibuat karyawan di workshop dari
 * bahan sesuai resep barang (ItemRecipeLine). Upah borongan TIDAK ada (karyawan bergaji tetap). Posting memakai fungsi stok yang sama:
 *  - PEMAKAIAN bahan: KONSUMSI_PRODUKSI (harga rata-rata ikut) dari gudang sesuai tipe komponen
 *  - HASIL: HASIL_PRODUKSI setengah jadi bernilai bahan terpakai + overhead resep sendiri (full costing, Cr 6-1850)
 *  - Jurnal pindah antar akun persediaan: Dr persediaan hasil / Cr persediaan bahan / Cr 6-1850. Tidak ada beban laba-rugi.
 * Semua mutasi ber-ref `WSP:<nomor>` (riwayat stok, diagnosa harian). Pembatalan = mutasi & jurnal dibalik.
 */
type Actor = { id: string; name: string };
export const WORKSHOP_SOURCE = "WORKSHOP";
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type PlanLine = { itemId: string; name: string; unit: string; type: ItemType; perUnit: number; planned: number; available: number };
export type WorkshopPlan = { output: { id: string; name: string; unit: string; type: ItemType }; qty: number; lines: PlanLine[] };

const locOf = (type: ItemType, l: { raw: string | null; wip: string | null; finished: string | null }) => (type === "BAHAN_BAKU" ? l.raw : type === "BARANG_DALAM_PROSES" ? l.wip : l.finished);

type Db = Prisma.TransactionClient | typeof prisma;

/** Komponen sebuah barang: resep barang (ItemRecipeLine) atau, bila tidak ada, BOM produk yang barang jadinya barang itu (mis. Paket 12) */
export async function recipeOf(db: Db, itemId: string) {
  const own = await db.itemRecipeLine.findMany({ where: { itemId }, include: { component: true } });
  if (own.length) return own.map((r) => ({ component: r.component, qty: r.qty }));
  const bom = await db.bomLine.findMany({ where: { product: { finishedItemId: itemId } }, include: { item: true } });
  return bom.map((b) => ({ component: b.item, qty: b.qty }));
}

/** Barang yang bisa diproduksi / dirakit ulang: setengah jadi / jadi aktif yang punya resep atau BOM */
export async function workshopItems(db: Db = prisma) {
  return db.item.findMany({ where: { active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] }, OR: [{ recipe: { some: {} } }, { product: { is: { bom: { some: {} } } } }] }, select: { id: true, sku: true, name: true, unit: true, type: true }, orderBy: [{ name: "asc" }] });
}

/** Bahan otomatis dari resep × jumlah hasil (satuan stok), beserta stok tersedia di gudangnya */
export async function workshopPlan(db: Db, itemId: string, qty: number): Promise<WorkshopPlan> {
  if (!(qty > 0)) throw new StockError("Jumlah hasil harus lebih dari 0");
  const item = await db.item.findUniqueOrThrow({ where: { id: itemId } });
  if (!item.active || !["BARANG_DALAM_PROSES", "BARANG_JADI"].includes(item.type)) throw new StockError(`${item.name} bukan barang setengah jadi / jadi`);
  const recipe = await recipeOf(db, itemId);
  if (!recipe.length) throw new StockError(`${item.name} belum punya resep bahan (Produk & HPP → resep)`);
  const locs = await locationSettings(db);
  const lines: PlanLine[] = [];
  for (const r of recipe) {
    const c = r.component;
    const perUnit = bomStockQty(r.qty, c);
    const loc = locOf(c.type, locs);
    lines.push({ itemId: c.id, name: c.name, unit: c.unit, type: c.type, perUnit, planned: round3(perUnit * qty), available: loc ? await qtyAt(db, c.id, loc) : 0 });
  }
  return { output: { id: item.id, name: item.name, unit: item.unit, type: item.type }, qty, lines };
}

/** WSP = produksi workshop; RAS = rakit ulang (komponen layak hasil bongkar retur + pengganti dari stok → produk jadi kembali) */
export type WorkshopKind = "WSP" | "RAS";
export type WorkshopInput = { outputItemId: string; qty: number; date?: Date; note?: string | null; kind?: WorkshopKind; /** Qty bahan AKTUAL (satuan stok) bila beda dari resep; kunci = itemId */ actual?: Record<string, number>; /** Komponen pengganti di luar resep (satuan stok) */ extra?: { itemId: string; qty: number }[] };

export async function recordWorkshop(input: WorkshopInput, actor: Actor) {
  const date = input.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    const plan = await workshopPlan(tx, input.outputItemId, input.qty);
    const locs = await locationSettings(tx);
    const outLoc = locOf(plan.output.type, locs);
    if (!outLoc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
    const kind = input.kind ?? "WSP";
    const number = await nextNumber(tx, kind, date);
    const ref = `${kind}:${number}`;
    const note = `${kind === "RAS" ? "Rakit ulang" : "Produksi workshop"} ${plan.output.name} × ${input.qty}${input.note ? ` · ${input.note}` : ""}`;
    const used = new Map<ItemType, number>();
    let total = 0;
    const extraItems = input.extra?.length ? await tx.item.findMany({ where: { id: { in: input.extra.map((e) => e.itemId) } } }) : [];
    const lines = [...plan.lines, ...(input.extra ?? []).filter((e) => e.qty > 0).map((e) => { const it = extraItems.find((x) => x.id === e.itemId); if (!it) throw new StockError("Komponen pengganti tidak ditemukan"); return { itemId: it.id, name: it.name, unit: it.unit, type: it.type, perUnit: 0, planned: round3(e.qty), available: 0 } satisfies PlanLine; })];
    for (const l of lines) {
      const q = round3(input.actual?.[l.itemId] ?? l.planned);
      if (!(q >= 0)) throw new StockError(`Qty bahan ${l.name} tidak valid`);
      if (q === 0) continue;
      const loc = locOf(l.type, locs);
      if (!loc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
      const mv = await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: l.itemId, qty: q, fromLocationId: loc, ref, note, date }, actor);
      const value = Math.round(q * Number(mv.unitCost));
      total += value;
      used.set(l.type, (used.get(l.type) ?? 0) + value);
    }
    if (total <= 0) throw new StockError("Bahan terpakai bernilai Rp 0: isi harga bahan (pembelian / stok awal) dulu agar nilai hasil benar");
    const oh = await applyOwnOverhead(tx, plan.output.id, input.qty, date);
    const value = total + oh.total;
    await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: plan.output.id, qty: input.qty, toLocationId: outLoc, unitCost: Math.round(value / input.qty), ref, note, date }, actor);
    const j = await postJournal(tx, {
      date, storeId: await defaultStoreId(tx), description: `${note} (${number})`, source: WORKSHOP_SOURCE, sourceId: number, actor,
      lines: [
        { accountCode: INVENTORY_COA[plan.output.type], debit: value },
        ...[...used].map(([t, v]) => ({ accountCode: INVENTORY_COA[t], credit: v })),
        ...overheadCreditLines(oh),
      ],
    });
    await audit(actor, kind === "RAS" ? "RAKIT_ULANG" : "PRODUKSI_WORKSHOP", "Item", plan.output.id, { number, qty: input.qty, bahan: total, overhead: oh.total, journalId: j.id }, tx);
    return { number, ref, kind, value, bahan: total, overhead: oh.total, unitCost: Math.round(value / input.qty), plan };
  }, { timeout: 30000 });
}

/** Batalkan produksi workshop (salah input): mutasi stok & jurnal dibalik, tidak dihapus */
export async function cancelWorkshop(number: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const ref = `${number.startsWith("RAS") ? "RAS" : "WSP"}:${number}`;
    if (await tx.stockMovement.findFirst({ where: { ref: `BATAL-${ref}` } })) throw new StockError(`${number} sudah dibatalkan`);
    if (!(await tx.stockMovement.findFirst({ where: { ref } }))) throw new StockError(`${number} tidak ditemukan`);
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, `Batal produksi workshop: ${reason}`, actor);
    const js = await tx.journal.findMany({ where: { source: WORKSHOP_SOURCE, sourceId: number, reversalOfId: null } });
    for (const j of js) await reverseJournal(tx, j.id, new Date(), actor, `Batal produksi workshop: ${reason}`);
    await audit(actor, "PRODUKSI_WORKSHOP_BATAL", "StockMovement", number, { reason }, tx);
    return { number };
  });
}

/** Riwayat produksi workshop terbaru (hasil per nomor) */
export async function workshopHistory(limit = 30) {
  const rows = await prisma.stockMovement.findMany({ where: { OR: [{ ref: { startsWith: "WSP:" } }, { ref: { startsWith: "RAS:" } }], type: "HASIL_PRODUKSI" }, orderBy: { date: "desc" }, take: limit, include: { item: { select: { name: true, unit: true } } } });
  const cancelled = new Set((await prisma.stockMovement.findMany({ where: { ref: { in: rows.map((r) => `BATAL-${r.ref}`) } }, select: { ref: true } })).map((r) => r.ref!.replace(/^BATAL-/, "")));
  return rows.map((r) => ({ number: r.ref!.slice(4), kind: r.ref!.slice(0, 3) as WorkshopKind, date: r.date, item: r.item.name, unit: r.item.unit, qty: Number(r.qty), unitCost: Number(r.unitCost), by: r.createdBy, cancelled: cancelled.has(r.ref!) }));
}

