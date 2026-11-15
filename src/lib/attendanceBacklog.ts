import { prisma } from "./db";
import { dateStr, todayStr } from "./time";
import { reconcileDay, type DayChange } from "./attendanceAuto";

const KIND: Record<DayChange["kind"], string> = {
  STATUS_BARU: "status baru",
  STATUS_DIUBAH: "status diubah",
  DIVALIDASI: "divalidasi apa adanya",
  SHIFT_DISESUAIKAN: "shift disesuaikan",
  JADWAL_DIISI: "jadwal diisi",
};

/**
 * Selesaikan antrean validasi lama (absensi validated=false sebelum hari ini) dengan aturan otomatis.
 * Hanya karyawan yang ada di antrean pada tanggal itu yang dihitung; data tidak dihapus; setiap perubahan dicatat
 * di audit log. `apply` false = pratinjau.
 */
export async function resolveAttendanceBacklog(apply: boolean, now = new Date()) {
  const rows = await prisma.attendance.findMany({ where: { validated: false, date: { lt: new Date(`${todayStr(now)}T00:00:00Z`) } }, select: { employeeId: true, date: true } });
  const byDay = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = dateStr(r.date);
    if (!byDay.has(d)) byDay.set(d, new Set());
    byDay.get(d)!.add(r.employeeId);
  }
  const all: DayChange[] = [];
  for (const day of [...byDay.keys()].sort()) all.push(...(await reconcileDay(day, { apply, employeeIds: [...byDay.get(day)!] })));
  const lines = all.map((c) => `${c.date} · ${c.name}: ${KIND[c.kind]}${c.from ? ` ${c.from} →` : ""}${c.to ? ` ${c.to}` : ""}`);
  return { queue: rows.length, changes: all, lines };
}
