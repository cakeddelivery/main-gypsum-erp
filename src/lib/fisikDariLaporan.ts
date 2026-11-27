import { prisma } from "./db";
import { RESULT_KEY } from "./shiftResultCount";
import type { StockCountRow } from "./shiftReport";

type Db = typeof prisma;

/**
 * Hitungan fisik dari stok akhir laporan shift TERKIRIM divisi Packing (stockCount bahan + hitungan hasil `_hasil`).
 * spec = "YYYY-MM-DD:<shift>" (S1 / 1 / Shift 1). Barang yang tidak ada di laporan TIDAK diisi (tidak ada nilai diam-diam).
 */
export async function fisikDariLaporan(spec: string, db: Db = prisma) {
  const m = /^(\d{4}-\d{2}-\d{2}):(.+)$/.exec(spec.trim());
  if (!m) throw new Error("--fisik-dari-laporan harus YYYY-MM-DD:<shift>, mis. 2026-11-27:S1");
  const [, date, shiftRaw] = m;
  const shiftKey = shiftRaw.trim();
  const code = /^\d+$/.test(shiftKey) ? `S${shiftKey}` : shiftKey.replace(/^shift\s*/i, "S").toUpperCase();
  const shift = await db.shift.findFirst({ where: { OR: [{ code }, { name: { equals: shiftKey, mode: "insensitive" } }] } });
  if (!shift) throw new Error(`Shift "${shiftKey}" tidak ditemukan`);
  const report = await db.shiftReport.findFirst({
    where: { date: new Date(`${date}T00:00:00.000Z`), shiftId: shift.id, division: { reportTemplate: "PACKING" }, status: { in: ["TERKIRIM", "DIREVISI"] } },
    include: { division: { select: { name: true } }, shift: { select: { name: true } } },
  });
  if (!report) throw new Error(`Tidak ada laporan shift ${shift.name} divisi Packing tanggal ${date} yang terkirim`);
  const counts = new Map<string, number>();
  for (const r of report.stockCount as StockCountRow[]) if (r.qty != null && Number.isFinite(r.qty)) counts.set(r.itemId, r.qty);
  const hasil = (report.work as Record<string, unknown> | null)?.[RESULT_KEY];
  if (hasil && typeof hasil === "object" && !Array.isArray(hasil)) for (const [id, n] of Object.entries(hasil as Record<string, unknown>)) if (typeof n === "number" && Number.isFinite(n)) counts.set(id, n);
  return { report: { id: report.id, date, shift: report.shift.name, division: report.division.name, status: report.status }, counts };
}
