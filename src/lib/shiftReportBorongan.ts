import { prisma } from "./db";
import type { ReportTemplate } from "./shiftReport";

/** Pekerjaan borongan yang ditampilkan di laporan divisi (berdasarkan nama pekerjaan) */
const TASK_MATCH: Partial<Record<ReportTemplate, RegExp>> = { ASSEMBLING: /assembl|cat plastik/i, GIFTBOX: /giftbox/i };

/**
 * Hasil borongan (BMR/Mastrip) di tanggal laporan, diambil dari setoran hasil Borongan (hanya ditampilkan).
 * Stoknya sudah tercatat saat setoran, jadi tidak diposting ulang dari laporan shift.
 */
export async function boronganLines(template: ReportTemplate | null, date: Date, divisionId?: string | null): Promise<string[]> {
  const re = template ? TASK_MATCH[template] : undefined;
  const rows = await prisma.boronganResult.findMany({ where: { date }, include: { point: { select: { name: true } }, task: { select: { name: true, divisionId: true } } } });
  const sum = new Map<string, number>();
  for (const r of rows) {
    // Tugas yang punya divisi pencatat → laporan divisi itu; tugas tanpa divisi → menurut nama (cara lama)
    const mine = r.task.divisionId ? r.task.divisionId === divisionId : !!re?.test(r.task.name);
    if (!mine) continue;
    const k = `${r.point.name} · ${r.task.name}`;
    sum.set(k, (sum.get(k) ?? 0) + r.qty);
  }
  if (!sum.size) return [];
  const total = [...sum.values()].reduce((a, q) => a + q, 0);
  return ["SETORAN BORONGAN (dari menu Borongan, stok sudah tercatat)", ...[...sum].map(([k, q]) => `${k}: ${q.toLocaleString("id-ID")} pcs`), `TOTAL SETORAN: ${total.toLocaleString("id-ID")} pcs`];
}
