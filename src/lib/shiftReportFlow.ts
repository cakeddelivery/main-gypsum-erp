import type { Prisma, ProductVariant } from "@prisma/client";
import { prisma } from "./db";
import { COA, postJournal, reverseJournal } from "./accounting";
import { locationSettings, recordMovement, reverseMovementsByRef, usageAccountCode } from "./stock";
import { isTemplate, plannedFlow, shiftEndAt, type FlowStep, type WorkData } from "./shiftReport";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Setting: hasil kerja laporan shift jadi sumber stok setengah jadi & barang jadi ("true"/"false", bawaan mati) */
export const FLOW_SETTING = "laporan_shift_ke_stok";
export const FLOW_SOURCE = "LAPORAN_SHIFT";
/** Tahap produksi manual yang ditutup (kecuali Owner) saat laporan shift jadi sumber stok, agar tidak dobel */
export const FLOW_STAGES = ["PANEN_1", "PANEN_2", "ASSEMBLING", "PACKING", "BARANG_JADI"] as const;

export async function flowEnabled(db: Tx | typeof prisma = prisma) {
  return (await db.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value === "true";
}

const VARIANT_ENUM: Record<string, ProductVariant> = { Hewan: "HEWAN", Cowok: "COWOK", Transportasi: "TRANSPORTASI", Cewek: "CEWEK" };

async function ensureItem(tx: Tx, sku: string, data: { name: string; type: "BARANG_DALAM_PROSES" | "BARANG_JADI"; unit: string }) {
  const ex = await tx.item.findUnique({ where: { sku } });
  if (ex) return ex.id;
  return (await tx.item.create({ data: { sku, ...data } })).id;
}

/**
 * Barang untuk tiap langkah (dibuat otomatis bila belum ada, kode tetap):
 * - Patung kering <varian> (setengah jadi) — SJ-PTG-<VARIAN>
 * - Produk jadi satuan <varian>: barang jadi produk SATUAN varian itu di Produk & HPP; bila belum ada — BJ-SAT-<VARIAN>
 * - Giftbox <kode> — BJ-GB-<KODE>
 */
export async function flowItem(tx: Tx, s: Pick<FlowStep, "kind" | "key">): Promise<string> {
  if (s.kind === "kering") return ensureItem(tx, `SJ-PTG-${s.key.toUpperCase()}`, { name: `Patung kering ${s.key}`, type: "BARANG_DALAM_PROSES", unit: "pcs" });
  if (s.kind === "giftbox") return ensureItem(tx, `BJ-GB-${s.key.toUpperCase()}`, { name: `Giftbox ${s.key}`, type: "BARANG_JADI", unit: "box" });
  const p = await tx.product.findFirst({ where: { type: "SATUAN", variant: VARIANT_ENUM[s.key], active: true, finishedItemId: { not: null } }, orderBy: { sku: "asc" } });
  if (p?.finishedItemId) return p.finishedItemId;
  return ensureItem(tx, `BJ-SAT-${s.key.toUpperCase()}`, { name: `Patung satuan ${s.key}`, type: "BARANG_JADI", unit: "pcs" });
}

/** Batalkan posting versi `v`: mutasi stok dibalik (harga rata-rata ikut), jurnalnya dibalik (tidak dihapus) */
async function reverseVersion(tx: Tx, reportId: string, v: number, actor: Actor) {
  const ref = `LPH:${reportId}:${v}`;
  const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
  await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, "Revisi laporan shift (hasil kerja)", actor);
  const journals = await tx.journal.findMany({
    where: { reversalOfId: null, OR: [{ source: FLOW_SOURCE, sourceId: `${reportId}:${v}` }, { source: "STOK", sourceId: { in: moves.map((m) => m.id) } }] },
  });
  for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, "Revisi laporan shift");
}

export type FlowResult = { posted: number; skipped?: string };

/**
 * Posting hasil kerja laporan shift ke stok (saat laporan dikirim), bertanggal jam selesai shift:
 * - Produksi: panen → + patung kering per varian (gudang setengah jadi)
 * - Assembling: produk jadi → − patung kering, + produk jadi satuan (gudang barang jadi), nilai bahan dari resep:
 *   Dr Persediaan Barang Jadi / Cr HPP Pemakaian Bahan Baku (bahan sudah dibebankan lewat stock opname, jadi tidak dobel)
 * - Giftbox: − 5 patung kering per box, giftbox masuk lalu langsung keluar (dikirim divisi Giftbox) → HPP
 * - Packing: patung satuan + paket mix (dibagi rata per varian) keluar dari barang jadi → HPP
 * Hasil borongan (BMR/Mastrip) tidak diposting di sini: stoknya sudah dari setoran Borongan.
 * Revisi: posting versi lama dibalik, lalu versi baru diposting. Hanya berjalan bila setting FLOW_SETTING menyala.
 */
export async function postShiftWork(reportId: string, actor: Actor, now: Date = new Date()): Promise<FlowResult> {
  if (!(await flowEnabled())) return { posted: 0, skipped: "nonaktif" };
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const template = r.division.reportTemplate;
  if (!isTemplate(template)) return { posted: 0, skipped: "laporan umum" };
  const steps = plannedFlow(template, r.work as WorkData);
  if (!steps.length && r.workPostedVersion === 0) return { posted: 0 };
  const { wip, finished } = await locationSettings(prisma);
  if (!wip || !finished) throw new Error("Lokasi gudang setengah jadi / barang jadi belum diatur di Pengaturan");
  const storeId = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
  if (!storeId) throw new Error("Toko default belum diatur di Pengaturan");
  const { recipeMaterialCost } = await import("./hpp");
  const at = shiftEndAt(r.date, r.shift, now);
  // Nilai resep dibaca di luar transaksi (fungsi HPP memakai koneksi biasa)
  const costs = new Map<string, number>();
  const itemIds = await prisma.$transaction(async (tx) => Promise.all(steps.map((s) => flowItem(tx, s))));
  for (const id of new Set(itemIds)) costs.set(id, await recipeMaterialCost(id));

  let posted = 0;
  await prisma.$transaction(async (tx) => {
    if (r.workPostedVersion > 0) await reverseVersion(tx, r.id, r.workPostedVersion, actor);
    const v = r.workPostedVersion + 1;
    const ref = `LPH:${r.id}:${v}`;
    const note = `Laporan shift ${r.division.name} ${r.shift.name}`;
    let toInventory = 0;
    for (const [i, s] of steps.entries()) {
      const itemId = itemIds[i];
      const loc = s.kind === "kering" ? wip : finished;
      if (s.dir === "in") {
        const unitCost = s.kind === "kering" ? undefined : costs.get(itemId) ?? 0;
        await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId, qty: s.qty, toLocationId: loc, unitCost, ref, note, date: at }, actor);
        if (unitCost) toInventory += unitCost * s.qty;
      } else if (s.kind === "kering") {
        await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId, qty: s.qty, fromLocationId: loc, allowNegative: true, ref, note, date: at }, actor);
      } else {
        const fb = costs.get(itemId) ?? 0;
        await recordMovement(tx, { type: "PENGELUARAN", itemId, qty: s.qty, fromLocationId: loc, allowNegative: true, fallbackUnitCost: fb > 0 ? { value: fb, note: "harga pokok dari resep" } : null, ref, note, date: at }, actor);
      }
      posted++;
    }
    // Nilai bahan (dari resep) pindah dari HPP Pemakaian Bahan Baku ke persediaan barang jadi
    if (toInventory > 0) {
      await postJournal(tx, {
        date: at, storeId, description: `${note}: barang jadi (nilai bahan dari resep)`, source: FLOW_SOURCE, sourceId: `${r.id}:${v}`, actor,
        lines: [{ accountCode: COA.PERSEDIAAN_JADI, debit: Math.round(toInventory) }, { accountCode: await usageAccountCode(tx), credit: Math.round(toInventory) }],
      });
    }
    await tx.shiftReport.update({ where: { id: r.id }, data: { workPostedVersion: v } });
  }, { timeout: 60000 });
  return { posted };
}
