import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { fmtDay } from "./time";
import { locationSettings, qtyAt, recordMovement } from "./stock";
import { VARIANTS, shiftEndAt, type ReportTemplate, type WorkData } from "./shiftReport";
import { flowEnabled, flowItem } from "./shiftReportFlow";

type Actor = { id: string; name: string };

/** Kunci hitungan stok akhir hasil di data hasil kerja laporan (work._hasil = { Hewan: n, ... }) */
export const RESULT_KEY = "_hasil";

/**
 * Stok akhir hasil per divisi (hitung fisik di akhir shift):
 * - Produksi: patung kering per karakter di gudang setengah jadi
 * - Assembling: produk jadi per karakter di gudang barang jadi (hasil borongan yang sudah sampai gudang)
 */
export const RESULT_COUNT: Partial<Record<ReportTemplate, { title: string; kind: "kering" | "jadi"; label: string; unit: string }>> = {
  PRODUKSI: { title: "Stok akhir patung kering", kind: "kering", label: "Patung kering", unit: "pcs" },
  ASSEMBLING: { title: "Stok akhir produk jadi per karakter", kind: "jadi", label: "Produk jadi", unit: "pcs" },
};

export function resultValues(work: WorkData): Record<string, number | null> {
  const v = work[RESULT_KEY];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number | null>) : {};
}

/** Baca hitungan dari FormData "rc.<karakter>" */
export function parseResultCount(template: ReportTemplate | null, get: (k: string) => string | null): Record<string, number | null> | null {
  if (!template || !RESULT_COUNT[template]) return null;
  const out: Record<string, number | null> = {};
  for (const v of VARIANTS) {
    const s = (get(`rc.${v}`) ?? "").trim().replace(/\./g, "").replace(/,/g, ".");
    if (!s) { out[v] = null; continue; }
    const x = Number(s);
    if (!Number.isFinite(x) || x < 0) throw new Error("Angka stok akhir hasil tidak valid");
    out[v] = Math.round(x);
  }
  return out;
}

export type ResultRow = { variant: string; itemId: string; counted: number; system: number; diff: number };

async function locFor(kind: "kering" | "jadi") {
  const { wip, finished } = await locationSettings(prisma);
  return kind === "kering" ? wip : finished;
}

/** Hitungan vs stok sistem per jam selesai shift (hanya karakter yang dihitung) */
export async function resultCountStatus(reportId: string, now: Date = new Date()): Promise<{ title: string; rows: ResultRow[]; applies: boolean } | null> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const def = RESULT_COUNT[r.division.reportTemplate as ReportTemplate];
  if (!def) return null;
  const vals = resultValues(r.work as WorkData);
  const loc = await locFor(def.kind);
  if (!loc) return null;
  const at = shiftEndAt(r.date, r.shift, now);
  const rows: ResultRow[] = [];
  for (const v of VARIANTS) {
    const c = vals[v];
    if (c == null) continue;
    const itemId = await prisma.$transaction((tx) => flowItem(tx, { kind: def.kind, key: v }));
    const system = Math.round((await qtyAt(prisma, itemId, loc, at)) * 1000) / 1000;
    rows.push({ variant: v, itemId, counted: c, system, diff: Math.round((c - system) * 1000) / 1000 });
  }
  return { title: def.title, rows, applies: await flowEnabled() };
}

/** Baris teks selisih hitungan vs sistem untuk pesan laporan (tanda untuk Owner) */
export function resultLines(s: NonNullable<Awaited<ReturnType<typeof resultCountStatus>>>): string[] {
  if (!s.rows.length) return [];
  const f = (x: number) => x.toLocaleString("id-ID");
  return [
    s.title.toUpperCase(),
    ...s.rows.map((r) => `${r.variant}: ${f(r.counted)} pcs${r.diff === 0 ? " ✓ sesuai sistem" : ` ⚠ sistem ${f(r.system)} (selisih ${r.diff > 0 ? "+" : ""}${f(r.diff)})`}`),
    ...(s.rows.some((r) => r.diff !== 0) ? [s.applies ? "Stok sistem disamakan dengan hitungan (selisih persediaan)." : "Selisih hanya ditandai; stok sistem belum diubah (sakelar Hasil kerja → stok belum menyala)."] : []),
  ];
}

/**
 * Terapkan stok akhir hasil ke stok sistem (hanya bila sakelar "Hasil kerja → stok" menyala).
 * Sama seperti stock opname bahan: per jam selesai shift, laporan lama tidak menimpa laporan lebih baru, revisi hanya selisihnya.
 * Selisih dibukukan sebagai selisih persediaan (bukan HPP / pemakaian bahan).
 */
export async function applyResultCount(reportId: string, actor: Actor, now: Date = new Date()): Promise<{ adjusted: number; skipped?: string }> {
  if (!(await flowEnabled())) return { adjusted: 0, skipped: "nonaktif" };
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const def = RESULT_COUNT[r.division.reportTemplate as ReportTemplate];
  if (!def) return { adjusted: 0 };
  const vals = resultValues(r.work as WorkData);
  if (!VARIANTS.some((v) => vals[v] != null) && !r.resultApplied) return { adjusted: 0 };
  const loc = await locFor(def.kind);
  if (!loc) throw new Error("Lokasi gudang setengah jadi / barang jadi belum diatur di Pengaturan");
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
  const prev = new Map(((r.resultApplied as { itemId: string; qty: number }[] | null) ?? []).map((x) => [x.itemId, x.qty]));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    const snapshot = new Map(prev);
    for (const v of VARIANTS) {
      const c = vals[v];
      if (c == null) continue;
      const itemId = await flowItem(tx, { kind: def.kind, key: v });
      const before = prev.get(itemId);
      const base = before != null ? before : await qtyAt(tx, itemId, loc, at);
      const diff = Math.round((c - base) * 1000) / 1000;
      snapshot.set(itemId, c);
      if (diff === 0) continue;
      await recordMovement(tx, {
        type: "PENYESUAIAN", itemId, qty: Math.abs(diff), fromLocationId: loc, increase: diff > 0, allowNegative: true,
        ref: `LPS:${r.id}`, note: `${before != null ? "Revisi stok" : "Stok"} akhir hasil laporan shift ${r.division.name} ${r.shift.name}`, date: at,
      }, actor);
      n++;
    }
    await tx.shiftReport.update({ where: { id: r.id }, data: { resultApplied: [...snapshot].map(([itemId, qty]) => ({ itemId, qty })) as unknown as Prisma.InputJsonValue } });
  }, { timeout: 30000 });
  return { adjusted: n };
}
