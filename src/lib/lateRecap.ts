import { prisma } from "./db";
import { dateOnly } from "./time";

/**
 * Rekap keterlambatan (hanya rekap, TIDAK memotong gaji): yang dihitung telat hanya absen berstatus Terlambat
 * (lewat toleransi shift). Menit = menit sejak jam mulai shift.
 */
export function lateOf(rows: { status: string; lateMinutes: number }[]) {
  const late = rows.filter((a) => a.status === "TERLAMBAT");
  return { count: late.length, minutes: late.reduce((s, a) => s + a.lateMinutes, 0) };
}

export type LateRow = { employeeId: string; name: string; division: string; count: number; minutes: number; days: { date: Date; minutes: number }[] };

/** Rekap telat per karyawan dalam rentang tanggal [from, to] (YYYY-MM-DD), urut paling sering */
export async function lateRecap(from: string, to: string, divisionId?: string | null): Promise<LateRow[]> {
  const att = await prisma.attendance.findMany({
    where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, status: "TERLAMBAT", ...(divisionId ? { employee: { divisionId } } : {}) },
    include: { employee: { include: { division: true } } },
    orderBy: { date: "asc" },
  });
  const m = new Map<string, LateRow>();
  for (const a of att) {
    const r = m.get(a.employeeId) ?? { employeeId: a.employeeId, name: a.employee.name, division: a.employee.division.name, count: 0, minutes: 0, days: [] };
    r.count++;
    r.minutes += a.lateMinutes;
    r.days.push({ date: a.date, minutes: a.lateMinutes });
    m.set(a.employeeId, r);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.name.localeCompare(b.name));
}

/** Format menit jadi "1 jam 5 menit" / "12 menit" */
export function fmtMinutes(min: number) {
  if (min < 60) return `${min} menit`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} jam ${r} menit` : `${h} jam`;
}
