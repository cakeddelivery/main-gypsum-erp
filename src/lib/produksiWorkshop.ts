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

/** Barang yang bisa diproduksi di workshop: setengah jadi / jadi aktif yang punya resep bahan (ItemRecipeLine) */
export async function workshopItems(db: Prisma.TransactionClient | typeof prisma = prisma) {
  return db.item.findMany({ where: { active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] }, recipe: { some: {} } }, select: { id: true, sku: true, name: true, unit: true, type: true }, orderBy: [{ name: "asc" }] });
}

/** Bahan otomatis dari resep × jumlah hasil (satuan stok), beserta stok tersedia di gudangnya */
export async function workshopPlan(db: Prisma.TransactionClient | typeof prisma, itemId: string, qty: number): Promise<WorkshopPlan> {
  if (!(qty > 0)) throw new StockError("Jumlah hasil harus lebih dari 0");
  const item = await db.item.findUniqueOrThrow({ where: { id: itemId }, include: { recipe: { include: { component: true } } } });
  if (!item.active || !["BARANG_DALAM_PROSES", "BARANG_JADI"].includes(item.type)) throw new StockError(`${item.name} bukan barang setengah jadi / jadi`);
  if (!item.recipe.length) throw new StockError(`${item.name} belum punya resep bahan (Produk & HPP → resep)`);
  const locs = await locationSettings(db);
  const lines: PlanLine[] = [];
  for (const r of item.recipe) {
    const c = r.component;
    const perUnit = bomStockQty(r.qty, c);
    const loc = locOf(c.type, locs);
    lines.push({ itemId: c.id, name: c.name, unit: c.unit, type: c.type, perUnit, planned: round3(perUnit * qty), available: loc ? await qtyAt(db, c.id, loc) : 0 });
  }
  return { output: { id: item.id, name: item.name, unit: item.unit, type: item.type }, qty, lines };
}

export type WorkshopInput = { outputItemId: string; qty: number; date?: Date; note?: string | null; /** Qty bahan AKTUAL (satuan stok) bila beda dari resep; kunci = itemId */ actual?: Record<string, number> };

export async function recordWorkshop(input: WorkshopInput, actor: Actor) {
  const date = input.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    const plan = await workshopPlan(tx, input.outputItemId, input.qty);
    const locs = await locationSettings(tx);
    const outLoc = locOf(plan.output.type, locs);
    if (!outLoc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
    const number = await nextNumber(tx, "WSP", date);
    const ref = `WSP:${number}`;
    const note = `Produksi workshop ${plan.output.name} × ${input.qty}${input.note ? ` · ${input.note}` : ""}`;
    const used = new Map<ItemType, number>();
    let total = 0;
    for (const l of plan.lines) {
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
    await audit(actor, "PRODUKSI_WORKSHOP", "Item", plan.output.id, { number, qty: input.qty, bahan: total, overhead: oh.total, journalId: j.id }, tx);
    return { number, ref, value, bahan: total, overhead: oh.total, unitCost: Math.round(value / input.qty), plan };
  }, { timeout: 30000 });
}

/** Batalkan produksi workshop (salah input): mutasi stok & jurnal dibalik, tidak dihapus */
export async function cancelWorkshop(number: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const ref = `WSP:${number}`;
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
  const rows = await prisma.stockMovement.findMany({ where: { ref: { startsWith: "WSP:" }, type: "HASIL_PRODUKSI" }, orderBy: { date: "desc" }, take: limit, include: { item: { select: { name: true, unit: true } } } });
  const cancelled = new Set((await prisma.stockMovement.findMany({ where: { ref: { in: rows.map((r) => `BATAL-${r.ref}`) } }, select: { ref: true } })).map((r) => r.ref!.replace(/^BATAL-/, "")));
  return rows.map((r) => ({ number: r.ref!.slice(4), date: r.date, item: r.item.name, unit: r.item.unit, qty: Number(r.qty), unitCost: Number(r.unitCost), by: r.createdBy, cancelled: cancelled.has(r.ref!) }));
}

