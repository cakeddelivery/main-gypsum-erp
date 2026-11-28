import { divisionLocationId, splitConsumption } from "./ambilStok";
import type { Prisma, ProductVariant } from "@prisma/client";
import { prisma } from "./db";
import { COA, postJournal, reverseJournal, reversalDate } from "./accounting";
import { locationSettings, recordMovement, reverseMovementsByRef, usageAccountCode } from "./stock";
import { applyOwnOverhead, overheadCreditLines } from "./overheadFullCost";
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

/** Tanggal mulai stok terpadu (cut-over): laporan bertanggal sebelumnya TIDAK ikut diposting ke stok. Kosong = tanpa batas */
export const CUTOVER_SETTING = "stok_terpadu_mulai";
export async function cutoverDate(db: Tx | typeof prisma = prisma): Promise<string | null> {
  const v = (await db.setting.findUnique({ where: { key: CUTOVER_SETTING } }))?.value?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
/** Sakelar menyala DAN tanggal (laporan / hari ini) sudah sampai tanggal mulai: dasar semua posting laporan shift ke stok */
export async function flowEnabledOn(date: Date | string, db: Tx | typeof prisma = prisma) {
  if (!(await flowEnabled(db))) return false;
  const t = await cutoverDate(db);
  const d = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  return !t || d >= t;
}

import { SATUAN_ORDER } from "./singlePackFix";

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
 * - Giftbox <kode> — BJ-GB-<KODE> (laporan lama); SKU katalog → item barang jadi produknya
 */
export async function flowItem(tx: Tx, s: Pick<FlowStep, "kind" | "key">): Promise<string> {
  if (s.kind === "kering") return ensureItem(tx, `SJ-PTG-${s.key.toUpperCase()}`, { name: `Patung kering ${s.key}`, type: "BARANG_DALAM_PROSES", unit: "pcs" });
  if (s.kind === "basah") return ensureItem(tx, `SJ-CTK-${s.key.toUpperCase()}`, { name: `Patung cetak ${s.key}`, type: "BARANG_DALAM_PROSES", unit: "pcs" });
  if (s.kind === "giftbox") return ensureItem(tx, `BJ-GB-${s.key.toUpperCase()}`, { name: `Giftbox ${s.key}`, type: "BARANG_JADI", unit: "box" });
  if (s.kind === "produk") {
    // SKU katalog (Produk Induk): item barang jadi produk itu; dibuatkan bila belum ada
    const p = await tx.product.findUniqueOrThrow({ where: { id: s.key } });
    if (p.finishedItemId) return p.finishedItemId;
    const itemId = await ensureItem(tx, `BJ-${p.sku}`, { name: p.name, type: "BARANG_JADI", unit: p.type === "GIFTBOX" ? "box" : "pcs" });
    await tx.product.update({ where: { id: p.id }, data: { finishedItemId: itemId } });
    return itemId;
  }
  const p = await tx.product.findFirst({ where: { type: "SATUAN", variant: VARIANT_ENUM[s.key], active: true, finishedItemId: { not: null } }, orderBy: SATUAN_ORDER });
  if (p?.finishedItemId) return p.finishedItemId;
  return ensureItem(tx, `BJ-SAT-${s.key.toUpperCase()}`, { name: `Patung satuan ${s.key}`, type: "BARANG_JADI", unit: "pcs" });
}

/** Batalkan posting versi `v`: mutasi stok dibalik (harga rata-rata ikut), jurnalnya dibalik (tidak dihapus) */
async function reverseVersion(tx: Tx, reportId: string, v: number, actor: Actor) {
  const ref = `LPH:${reportId}:${v}`;
  const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
  await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, "Revisi laporan shift (hasil kerja)", actor, { keepDate: true });
  const journals = await tx.journal.findMany({
    where: { reversalOfId: null, OR: [{ source: FLOW_SOURCE, sourceId: { in: [`${reportId}:${v}`, `${reportId}:${v}:wip`] } }, { source: "STOK", sourceId: { in: moves.map((m) => m.id) } }] },
  });
  for (const j of journals) await reverseJournal(tx, j.id, await reversalDate(tx, j.date), actor, "Revisi laporan shift");
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
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  if (!(await flowEnabled())) return { posted: 0, skipped: "nonaktif" };
  if (!(await flowEnabledOn(r.date))) return { posted: 0, skipped: "sebelum tanggal mulai stok terpadu" };
  const template = r.division.reportTemplate;
  if (!isTemplate(template)) return { posted: 0, skipped: "laporan umum" };
  // Panen Oven realtime: yang sudah diposting per entri (+ Hasil Panen) tidak diposting lagi, hanya selisihnya
  const { isHarvestWork, netOfHarvest, reportHarvests } = await import("./shiftHarvest");
  const realtime = isHarvestWork(r.work);
  const harvests = realtime ? await reportHarvests(r.id) : [];
  const harvestSig = (h: { id: string; posted: boolean; cancelledAt: Date | null }[]) => h.map((x) => `${x.id}:${x.posted}:${!!x.cancelledAt}`).join(",");
  const steps = realtime ? netOfHarvest(plannedFlow(template, r.work as WorkData), harvests) : plannedFlow(template, r.work as WorkData);
  if (!steps.length && r.workPostedVersion === 0) return { posted: 0 };
  const { wip, finished } = await locationSettings(prisma);
  if (!wip || !finished) throw new Error("Lokasi gudang setengah jadi / barang jadi belum diatur di Pengaturan");
  const storeId = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
  if (!storeId) throw new Error("Toko default belum diatur di Pengaturan");
  const { recipeMaterialCost } = await import("./hpp");
  const at = shiftEndAt(r.date, r.shift, now);
  // Nilai resep dibaca di luar transaksi (fungsi HPP memakai koneksi biasa)
  const costs = new Map<string, number>();
  // Berurutan (bukan Promise.all): dua langkah untuk barang yang sama (mis. giftbox masuk & keluar) tidak boleh membuat SKU yang sama bersamaan
  const itemIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const s of steps) ids.push(await flowItem(tx, s));
    return ids;
  });
  const allCosts = itemIds.length ? await (await import("./hpp")).itemCosts() : undefined;
  for (const id of new Set(itemIds)) costs.set(id, await recipeMaterialCost(id, allCosts));
  // Setengah jadi (patung kering/cetak) yang punya resep (bahan + upah): masuk stok bernilai resep, bukan Rp 0
  const { costTargets } = await import("./hppNilai");
  const wipTargets = itemIds.length ? await costTargets(prisma) : new Map<string, { mat: number; labor: number; overhead: number; total: number }>();
  const wipLabor = new Map<string, number>(); // upah milik resep barang itu sendiri (yang belum dibukukan sebagai persediaan)
  for (const id of new Set(itemIds)) {
    if (!wipTargets.has(id)) continue;
    const own = await prisma.recipeLabor.findMany({ where: { itemId: id }, include: { task: { select: { ratePerPcs: true } } } });
    wipLabor.set(id, own.reduce((a, r) => a + (r.task && !r.override ? Number(r.task.ratePerPcs) : Number(r.rate)), 0));
  }

  const divLoc = await divisionLocationId(prisma, template);
  let posted = 0;
  await prisma.$transaction(async (tx) => {
    // Kunci laporan & baca ulang versinya: klik Kirim dua kali bersamaan tidak boleh memposting hasil kerja dua kali
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${r.id} FOR UPDATE`;
    const { workPostedVersion } = await tx.shiftReport.findUniqueOrThrow({ where: { id: r.id }, select: { workPostedVersion: true } });
    if (realtime && harvestSig(await reportHarvests(r.id, tx)) !== harvestSig(harvests)) throw new Error("Entri panen baru saja berubah, kirim ulang laporan");
    if (workPostedVersion > 0) await reverseVersion(tx, r.id, workPostedVersion, actor);
    const v = workPostedVersion + 1;
    const ref = `LPH:${r.id}:${v}`;
    const note = `Laporan shift ${r.division.name} ${r.shift.name}`;
    let toInventory = 0;
    // Setengah jadi bernilai resep: Dr Persediaan BDP (nilai masuk) − Cr BDP (nilai setengah jadi yang dikonsumsi) − Cr Beban Gaji Produksi (upah resep,
    // sudah dibebankan saat dibayar) − Cr 6-1850 Overhead Pabrik Dibebankan (overhead resep sendiri, dibatasi beban aktual bulan itu), sisanya (bahan) Cr HPP Pemakaian Bahan Baku
    let wipIn = 0;
    let wipOut = 0;
    let wipWage = 0;
    const wipOh: { overheadId: string; name: string; amount: number }[] = [];
    for (const [i, s] of steps.entries()) {
      const itemId = itemIds[i];
      const wipKind = s.kind === "kering" || s.kind === "basah";
      const loc = wipKind ? wip : finished;
      if (s.dir === "in") {
        const wipCost = wipKind ? wipTargets.get(itemId)?.total : undefined;
        // Overhead resep milik barang ini sendiri dikapitalisasi sebatas beban aktual bulan itu (sisanya tetap beban periode)
        const oh = wipKind && wipCost ? await applyOwnOverhead(tx, itemId, s.qty, at) : null;
        const inValue = wipKind && wipCost ? Math.round(wipCost * s.qty) - (oh ? oh.wanted - oh.total : 0) : 0;
        const unitCost = wipKind ? (wipCost ? Math.round(inValue / s.qty) : undefined) : costs.get(itemId) ?? 0;
        await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId, qty: s.qty, toLocationId: loc, unitCost, ref, note, date: at }, actor);
        if (wipKind && wipCost) {
          wipIn += Math.round((unitCost ?? 0) * s.qty);
          wipWage += Math.round((wipLabor.get(itemId) ?? 0) * s.qty);
          if (oh) wipOh.push(...oh.lines);
        } else if (unitCost) toInventory += unitCost * s.qty;
      } else if (wipKind) {
        // Patung kering dipakai Assembling/Giftbox: ambil dulu dari stok divisi (hasil "Ambil stok"), sisanya dari gudang setengah jadi
        const parts = s.kind === "kering" ? await splitConsumption(tx, itemId, s.qty, divLoc, loc) : [{ loc, qty: s.qty }];
        for (const part of parts) {
          const mv = await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId, qty: part.qty, fromLocationId: part.loc, allowNegative: true, ref, note, date: at }, actor);
          wipOut += Math.round(part.qty * Number(mv.unitCost));
        }
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
    if (wipIn > 0) {
      const wage = Math.min(wipWage, Math.max(0, wipIn - wipOut));
      const ohTotal = wipOh.reduce((a, l) => a + l.amount, 0);
      const usage = wipIn - wipOut - wage - ohTotal;
      await postJournal(tx, {
        date: at, storeId, description: `${note}: setengah jadi bernilai resep (bahan + upah)`, source: FLOW_SOURCE, sourceId: `${r.id}:${v}:wip`, actor,
        lines: [
          { accountCode: COA.PERSEDIAAN_BDP, debit: wipIn },
          ...(wipOut > 0 ? [{ accountCode: COA.PERSEDIAAN_BDP, credit: wipOut }] : []),
          ...(wage > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, credit: wage, memo: "Upah resep dikapitalisasi" }] : []),
          ...overheadCreditLines({ lines: wipOh, total: ohTotal, wanted: ohTotal }),
          ...(usage > 0 ? [{ accountCode: await usageAccountCode(tx), credit: usage }] : usage < 0 ? [{ accountCode: await usageAccountCode(tx), debit: -usage }] : []),
        ],
      });
    }
    await tx.shiftReport.update({ where: { id: r.id }, data: { workPostedVersion: v } });
  }, { timeout: 60000 });
  return { posted };
}

/** Karakter patung kering dengan stok terbanyak di gudang setengah jadi (bawaan "varian bebas" Giftbox Mix) */
export async function mostStockedVariant(): Promise<string> {
  const { VARIANTS } = await import("./shiftReport");
  const { wip } = await locationSettings(prisma);
  const items = await prisma.item.findMany({ where: { sku: { in: VARIANTS.map((v) => `SJ-PTG-${v.toUpperCase()}`) } }, select: { id: true, sku: true } });
  if (!wip || !items.length) return VARIANTS[0];
  const { qtyAt } = await import("./stock");
  let best = VARIANTS[0];
  let max = -Infinity;
  for (const v of VARIANTS) {
    const it = items.find((i) => i.sku === `SJ-PTG-${v.toUpperCase()}`);
    const q = it ? await qtyAt(prisma, it.id, wip) : -Infinity;
    if (q > max) [best, max] = [v, q];
  }
  return best;
}
