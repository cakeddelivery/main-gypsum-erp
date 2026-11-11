import { prisma } from "./db";
import type { ReportTemplate } from "./shiftReport";

/** Pekerjaan borongan yang ditampilkan di laporan divisi (berdasarkan nama pekerjaan) */
const TASK_MATCH: Partial<Record<ReportTemplate, RegExp>> = { ASSEMBLING: /assembl/i, GIFTBOX: /giftbox/i };

/**
 * Hasil borongan (BMR/Mastrip) di tanggal laporan, diambil dari setoran hasil Borongan (hanya ditampilkan).
 * Stoknya sudah tercatat saat setoran, jadi tidak diposting ulang dari laporan shift.
 */
export async function boronganLines(template: ReportTemplate | null, date: Date): Promise<string[]> {
  const re = template ? TASK_MATCH[template] : undefined;
  if (!re) return [];
  const rows = await prisma.boronganResult.findMany({ where: { date }, include: { point: { select: { name: true } }, task: { select: { name: true } } } });
  const sum = new Map<string, number>();
  for (const r of rows) {
    if (!re.test(r.task.name)) continue;
    const k = `${r.point.name} · ${r.task.name}`;
    sum.set(k, (sum.get(k) ?? 0) + r.qty);
  }
  if (!sum.size) return [];
  return ["HASIL BORONGAN (dari setoran, stok sudah tercatat)", ...[...sum].map(([k, q]) => `${k}: ${q.toLocaleString("id-ID")} pcs`)];
}
