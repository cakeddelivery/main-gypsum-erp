import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { COA, defaultStoreId, postJournal, reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { INVENTORY_COA, StockError, locationSettings, recordMovement, reverseMovementsByRef } from "./stock";
import { bomStockQty } from "./unitcost";
import { recipeOf } from "./produksiWorkshop";
import { COA_RETUR_RUSAK } from "./returns";

/**
 * BONGKAR RETUR (komponen): barang retur yang sudah diperiksa (Single Pack / paket, stoknya di WIP atau gudang barang jadi) dibongkar ke isi BOM-nya.
 * Pengguna menandai jumlah RUSAK per komponen (mis. paket 12: 2 patung pecah, 1 plastik OPP sobek). Posting (satu jurnal, ref `BRT:<nomor>`):
 *  - barang retur keluar dari stoknya (KONSUMSI_PRODUKSI, nilai = harga rata-rata)
 *  - komponen LAYAK masuk stok sesuai tipenya (HASIL_PRODUKSI) dengan nilai proporsional
 *  - komponen RUSAK: Dr 6-1810 Kerugian Barang Retur Rusak (terpisah dari reject produksi 6-1800), dicatat di laporan reject sebagai sumber "Retur" (tanpa jurnal ganda)
 * Tidak menjurnal ulang retur penjualan (RTR): jurnal periksa retur tetap milik modul Retur; ini hanya memindah nilai antar persediaan & reject.
 */
type Actor = { id: string; name: string };
export const BONGKAR_SOURCE = "BONGKAR_RETUR";
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const locOf = (type: ItemType, l: { raw: string | null; wip: string | null; finished: string | null }) => (type === "BAHAN_BAKU" ? l.raw : type === "BARANG_DALAM_PROSES" ? l.wip : l.finished);

export type BongkarLine = { itemId: string; name: string; unit: string; type: ItemType; perUnit: number; total: number };
export type BongkarPlan = { item: { id: string; name: string; unit: string; type: ItemType; avgCost: number }; qty: number; lines: BongkarLine[] };

/** Isi barang retur (komponen × jumlah) dari resep barang atau BOM produknya */
export async function bongkarPlan(db: Prisma.TransactionClient | typeof prisma, itemId: string, qty: number): Promise<BongkarPlan> {
  if (!(qty > 0)) throw new StockError("Jumlah barang yang dibongkar harus lebih dari 0");
  const item = await db.item.findUniqueOrThrow({ where: { id: itemId } });
  const recipe = await recipeOf(db, itemId);
  if (!recipe.length) throw new StockError(`${item.name} tidak punya isi (resep/BOM) yang bisa dibongkar`);
  const lines = recipe.map((r) => { const perUnit = bomStockQty(r.qty, r.component); return { itemId: r.component.id, name: r.component.name, unit: r.component.unit, type: r.component.type, perUnit, total: round3(perUnit * qty) }; });
  return { item: { id: item.id, name: item.name, unit: item.unit, type: item.type, avgCost: Number(item.avgCost) }, qty, lines };
}

export type BongkarInput = { itemId: string; qty: number; /** Jumlah RUSAK per komponen (satuan stok), kunci = itemId; kosong = 0 */ damaged?: Record<string, number>; reason?: string; returnNumber?: string | null; date?: Date; note?: string | null };

export async function bongkarRetur(input: BongkarInput, actor: Actor) {
  const date = input.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    const plan = await bongkarPlan(tx, input.itemId, input.qty);
    const locs = await locationSettings(tx);
    const srcLoc = locOf(plan.item.type, locs);
    if (!srcLoc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
    for (const [id, q] of Object.entries(input.damaged ?? {})) {
      const l = plan.lines.find((x) => x.itemId === id);
      if (!l && q > 0) throw new StockError("Komponen rusak tidak ada di isi barang ini");
      if (l && (q < 0 || q > l.total + 1e-9)) throw new StockError(`Jumlah rusak ${l.name} melebihi isinya (${l.total} ${l.unit})`);
    }
    const number = await nextNumber(tx, "BRT", date);
    const ref = `BRT:${number}`;
    const note = `Bongkar retur ${plan.item.name} × ${input.qty}${input.returnNumber ? ` (retur ${input.returnNumber})` : ""}${input.note ? ` · ${input.note}` : ""}`;
    const out = await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: plan.item.id, qty: input.qty, fromLocationId: srcLoc, ref, note, date }, actor);
    const totalValue = Math.round(input.qty * Number(out.unitCost));
    // Nilai dibagi ke komponen sesuai bobot (isi × harga rata-rata; bila semua Rp 0 → sama per pcs)
    const comps = await tx.item.findMany({ where: { id: { in: plan.lines.map((l) => l.itemId) } }, select: { id: true, avgCost: true, divisionId: true } });
    const w = plan.lines.map((l) => l.total * (Number(comps.find((c) => c.id === l.itemId)!.avgCost) || 0));
    const sw = w.reduce((a, b) => a + b, 0) || 0;
    const weights = sw > 0 ? w.map((x) => x / sw) : plan.lines.map((l) => l.total / plan.lines.reduce((a, b) => a + b.total, 0));
    const invDebit = new Map<ItemType, number>();
    let rejectValue = 0;
    let allocated = 0;
    const division = (await tx.division.findFirst({ where: { reportTemplate: "PACKING" }, select: { id: true } }))?.id;
    for (const [i, l] of plan.lines.entries()) {
      const compValue = i === plan.lines.length - 1 ? totalValue - allocated : Math.round(totalValue * weights[i]);
      allocated += compValue;
      const bad = round3(Math.min(input.damaged?.[l.itemId] ?? 0, l.total));
      const good = round3(l.total - bad);
      const badValue = l.total > 0 ? Math.round((compValue * bad) / l.total) : 0;
      const goodValue = compValue - badValue;
      if (good > 0) {
        const loc = locOf(l.type, locs);
        if (!loc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
        await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: l.itemId, qty: good, toLocationId: loc, unitCost: Math.round(goodValue / good), ref, note, date }, actor);
        invDebit.set(l.type, (invDebit.get(l.type) ?? 0) + goodValue);
      }
      if (bad > 0) {
        rejectValue += badValue;
        await tx.productionReject.create({ data: { reportId: ref, divisionId: comps.find((c) => c.id === l.itemId)?.divisionId ?? division ?? plan.item.id, stage: "RETUR", itemId: l.itemId, qty: bad, reason: input.reason && ["RETAK", "PECAH", "GOSONG", "CACAT_CAT", "SALAH_CETAK", "RUSAK_ALAT", "LAINNYA"].includes(input.reason) ? input.reason : "PECAH", note: `Bongkar retur ${number}${input.returnNumber ? ` (${input.returnNumber})` : ""}`.slice(0, 200), posted: true, ref, unitCost: BigInt(Math.round(badValue / bad)), createdBy: actor.name } });
      }
    }
    const j = await postJournal(tx, {
      date, storeId: await defaultStoreId(tx), description: `${note} (${number})`, source: BONGKAR_SOURCE, sourceId: number, actor,
      lines: [
        ...[...invDebit].filter(([, v]) => v > 0).map(([t, v]) => ({ accountCode: INVENTORY_COA[t], debit: v })),
        ...(rejectValue > 0 ? [{ accountCode: COA_RETUR_RUSAK, debit: rejectValue, memo: "Komponen retur rusak" }] : []),
        { accountCode: INVENTORY_COA[plan.item.type], credit: totalValue },
      ],
    });
    await audit(actor, "BONGKAR_RETUR", "Item", plan.item.id, { number, qty: input.qty, nilai: totalValue, reject: rejectValue, returnNumber: input.returnNumber ?? null, journalId: j.id }, tx);
    return { number, ref, totalValue, rejectValue, goodValue: totalValue - rejectValue, plan };
  }, { timeout: 30000 });
}

/** Batalkan bongkar retur: mutasi & jurnal dibalik, catatan reject dihapus (catatan turunan, bukan transaksi) */
export async function cancelBongkar(number: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const ref = `BRT:${number}`;
    if (await tx.stockMovement.findFirst({ where: { ref: `BATAL-${ref}` } })) throw new StockError(`${number} sudah dibatalkan`);
    if (!(await tx.stockMovement.findFirst({ where: { ref } }))) throw new StockError(`${number} tidak ditemukan`);
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, `Batal bongkar retur: ${reason}`, actor);
    for (const j of await tx.journal.findMany({ where: { source: BONGKAR_SOURCE, sourceId: number, reversalOfId: null } })) await reverseJournal(tx, j.id, new Date(), actor, `Batal bongkar retur: ${reason}`);
    await tx.productionReject.deleteMany({ where: { reportId: ref } });
    await audit(actor, "BONGKAR_RETUR_BATAL", "StockMovement", number, { reason }, tx);
    return { number };
  });
}
