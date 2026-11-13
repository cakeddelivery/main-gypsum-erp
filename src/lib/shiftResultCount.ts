import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { fmtDay } from "./time";
import { locationSettings, qtyAt, recordMovement } from "./stock";
import { VARIANTS, shiftEndAt, type WorkData } from "./shiftReport";
import { flowEnabled, flowItem } from "./shiftReportFlow";

type Actor = { id: string; name: string };
type Tx = Prisma.TransactionClient;

/** Kunci hitungan stok akhir hasil di data hasil kerja laporan (work._hasil = { [itemId]: n }) */
export const RESULT_KEY = "_hasil";
export const RESULT_TITLE = "Stok akhir setengah jadi / produk jadi";

/** Selisih dianggap besar (tanda untuk Owner): ≥ 10 unit dan ≥ 10% stok sistem */
export function bigDiff(diff: number, system: number) {
  return Math.abs(diff) >= 10 && Math.abs(diff) >= Math.abs(system) * 0.1;
}

/**
 * Barang setengah jadi & produk jadi yang menjadi tanggung jawab divisi (Master data → Divisi penanggung jawab).
 * Hanya barang aktif. Setengah jadi dihitung di gudang setengah jadi, produk jadi di gudang barang jadi.
 */
export async function resultItems(divisionId: string, db: Tx | typeof prisma = prisma) {
  return db.item.findMany({
    where: { divisionId, active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] } },
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, unit: true, type: true },
  });
}

/**
 * Hitungan tersimpan per id barang. Laporan lama menyimpan per karakter ("Hewan": n) untuk patung kering (Produksi)
 * atau produk jadi (Assembling): diterjemahkan ke barangnya.
 */
async function storedCounts(work: WorkData, template: string | null, tx: Tx): Promise<Map<string, number>> {
  const raw = work[RESULT_KEY];
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number | null>) : {};
  const out = new Map<string, number>();
  for (const [k, n] of Object.entries(v)) {
    if (n == null || !Number.isFinite(n)) continue;
    if (VARIANTS.includes(k)) {
      const kind = template === "PRODUKSI" ? "kering" : template === "ASSEMBLING" ? "jadi" : null;
      if (kind) out.set(await flowItem(tx, { kind, key: k }), n);
    } else out.set(k, n);
  }
  return out;
}

/** Nilai isian form per id barang (termasuk laporan lama per karakter) */
export async function resultValues(work: WorkData, template: string | null): Promise<Record<string, number>> {
  return Object.fromEntries(await prisma.$transaction((tx) => storedCounts(work, template, tx)));
}

/** Baca hitungan dari FormData "rc.<idBarang>" untuk barang divisi */
export function parseResultCount(itemIds: string[], get: (k: string) => string | null): Record<string, number> | null {
  if (!itemIds.length) return null;
  const out: Record<string, number> = {};
  for (const id of itemIds) {
    const s = (get(`rc.${id}`) ?? "").trim().replace(/\./g, "").replace(/,/g, ".");
    if (!s) continue;
    const x = Number(s);
    if (!Number.isFinite(x) || x < 0) throw new Error("Angka stok akhir setengah jadi / produk jadi tidak valid");
    out[id] = Math.round(x * 1000) / 1000;
  }
  return out;
}

export type ResultRow = { itemId: string; name: string; unit: string; counted: number; system: number; diff: number; big: boolean };

function locOf(type: ItemType, locs: { wip: string | null; finished: string | null }) {
  return type === "BARANG_DALAM_PROSES" ? locs.wip : type === "BARANG_JADI" ? locs.finished : null;
}

/** Hitungan vs stok sistem per jam selesai shift (hanya barang yang dihitung) */
export async function resultCountStatus(reportId: string, now: Date = new Date()): Promise<{ title: string; rows: ResultRow[]; applies: boolean } | null> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const counts = await prisma.$transaction((tx) => storedCounts(r.work as WorkData, r.division.reportTemplate, tx));
  if (!counts.size) return null;
  const locs = await locationSettings(prisma);
  const items = await prisma.item.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, name: true, unit: true, type: true } });
  const at = shiftEndAt(r.date, r.shift, now);
  const rows: ResultRow[] = [];
  for (const it of items) {
    const loc = locOf(it.type, locs);
    if (!loc) continue;
    const c = counts.get(it.id)!;
    const system = Math.round((await qtyAt(prisma, it.id, loc, at)) * 1000) / 1000;
    const diff = Math.round((c - system) * 1000) / 1000;
    rows.push({ itemId: it.id, name: it.name, unit: it.unit, counted: c, system, diff, big: bigDiff(diff, system) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { title: RESULT_TITLE, rows, applies: await flowEnabled() };
}

/** Baris teks selisih hitungan vs sistem untuk pesan laporan (tanda untuk Owner) */
export function resultLines(s: NonNullable<Awaited<ReturnType<typeof resultCountStatus>>>): string[] {
  if (!s.rows.length) return [];
  const f = (x: number) => x.toLocaleString("id-ID");
  return [
    s.title.toUpperCase(),
    ...s.rows.map((r) => `${r.name}: ${f(r.counted)} ${r.unit}${r.diff === 0 ? " ✓ sesuai sistem" : ` ⚠ sistem ${f(r.system)} (selisih ${r.diff > 0 ? "+" : ""}${f(r.diff)})${r.big ? " ‼ SELISIH BESAR" : ""}`}`),
    ...(s.rows.some((r) => r.diff !== 0) ? [s.applies ? "Stok sistem disamakan dengan hitungan (selisih persediaan)." : "Selisih hanya ditandai; stok sistem belum diubah (sakelar Hasil kerja → stok belum menyala)."] : []),
  ];
}

/**
 * Terapkan stok akhir setengah jadi / produk jadi ke stok sistem (hanya bila sakelar "Hasil kerja → stok" menyala).
 * Dipanggil SESUDAH hasil kerja diposting, jadi yang dibukukan hanya selisih sisanya.
 * Sama seperti stock opname bahan: per jam selesai shift, laporan lama tidak menimpa laporan lebih baru, revisi hanya selisihnya.
 * Selisih dibukukan sebagai selisih persediaan (bukan HPP / pemakaian bahan).
 */
export async function applyResultCount(reportId: string, actor: Actor, now: Date = new Date()): Promise<{ adjusted: number; skipped?: string }> {
  if (!(await flowEnabled())) return { adjusted: 0, skipped: "nonaktif" };
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const counts = await prisma.$transaction((tx) => storedCounts(r.work as WorkData, r.division.reportTemplate, tx));
  if (!counts.size && !r.resultApplied) return { adjusted: 0 };
  const locs = await locationSettings(prisma);
  if (!locs.wip || !locs.finished) throw new Error("Lokasi gudang setengah jadi / barang jadi belum diatur di Pengaturan");
  const newer = await prisma.shiftReport.findFirst({
    where: {
      id: { not: r.id },
      divisionId: r.divisionId,
      resultApplied: { not: Prisma.DbNull },
      OR: [{ date: { gt: r.date } }, { date: r.date, shift: { code: { gt: r.shift.code } } }],
    },
    include: { shift: true },
  });
  if (newer) return { adjusted: 0, skipped: `Stok hasil tidak diubah: sudah ada laporan lebih baru (${fmtDay(newer.date)} · ${newer.shift.name})` };
  const at = shiftEndAt(r.date, r.shift, now);
  const items = await prisma.item.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, type: true } });
  let n = 0;
  await prisma.$transaction(async (tx) => {
    // Kunci laporan & baca ulang hitungan yang sudah diterapkan (cegah selisih dibukukan dua kali saat Kirim ganda)
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${r.id} FOR UPDATE`;
    const fresh = await tx.shiftReport.findUniqueOrThrow({ where: { id: r.id }, select: { resultApplied: true } });
    const prev = new Map(((fresh.resultApplied as { itemId: string; qty: number }[] | null) ?? []).map((x) => [x.itemId, x.qty]));
    const snapshot = new Map(prev);
    for (const it of items) {
      const loc = locOf(it.type, locs);
      if (!loc) continue;
      const c = counts.get(it.id)!;
      const before = prev.get(it.id);
      const base = before != null ? before : await qtyAt(tx, it.id, loc, at);
      const diff = Math.round((c - base) * 1000) / 1000;
      snapshot.set(it.id, c);
      if (diff === 0) continue;
      await recordMovement(tx, {
        type: "PENYESUAIAN", itemId: it.id, qty: Math.abs(diff), fromLocationId: loc, increase: diff > 0, allowNegative: true,
        ref: `LPS:${r.id}`, note: `${before != null ? "Revisi stok" : "Stok"} akhir laporan shift ${r.division.name} ${r.shift.name}`, date: at,
      }, actor);
      n++;
    }
    await tx.shiftReport.update({ where: { id: r.id }, data: { resultApplied: [...snapshot].map(([itemId, qty]) => ({ itemId, qty })) as unknown as Prisma.InputJsonValue } });
  }, { timeout: 30000 });
  return { adjusted: n };
}
