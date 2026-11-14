import { prisma } from "./db";
import { audit } from "./audit";
import { addDays, dateOnly, dateStr, todayStr } from "./time";

/** Keterangan absen yang dibuat otomatis untuk hari tanpa catatan (keputusan Owner 14 Nov 2026) */
export const AUTO_NOTE = "Tanpa keterangan (otomatis)";
/** Berapa hari ke belakang yang diisi (agar hari yang terlewat saat job tidak berjalan tetap terisi) */
const LOOKBACK = 3;

/**
 * Setiap hari kerja harus punya status absensi. Karyawan aktif (bukan borongan) yang tidak punya catatan absen di hari
 * yang sudah lewat diberi status Alpa "Tanpa keterangan (otomatis)". Admin/Supervisor mengubahnya di menu Absensi menjadi
 * Libur / Izin / Sakit bila perlu. Gaji tidak berubah karenanya: slip tetap menghitung hari hadir, hari tanpa hadir
 * masuk jatah libur dulu, sisanya bolos (sama seperti sebelumnya). Aman diulang (satu catatan per karyawan per hari).
 */
export async function markMissingAttendance(now: Date = new Date()) {
  const today = todayStr(now);
  const goLive = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value ?? null;
  const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  if (!shifts.length) return { created: 0 };
  const emps = await prisma.employee.findMany({ where: { status: "AKTIF", wageType: { not: "BORONGAN" }, joinDate: { not: null } }, select: { id: true, name: true, joinDate: true, resignDate: true } });
  let created = 0;
  for (let k = LOOKBACK; k >= 1; k--) {
    const day = addDays(today, -k);
    if (goLive && day < goLive) continue;
    const d = dateOnly(day);
    const have = new Set((await prisma.attendance.findMany({ where: { date: d }, select: { employeeId: true } })).map((a) => a.employeeId));
    const todo = emps.filter((e) => !have.has(e.id) && dateStr(e.joinDate!) <= day && !(e.resignDate && dateStr(e.resignDate) <= day));
    if (!todo.length) continue;
    const sched = new Map((await prisma.shiftSchedule.findMany({ where: { date: d, employeeId: { in: todo.map((e) => e.id) } } })).map((s) => [s.employeeId, s.shiftId]));
    const r = await prisma.attendance.createMany({
      data: todo.map((e) => ({ employeeId: e.id, date: d, shiftId: sched.get(e.id) ?? shifts[0].id, status: "ALPA" as const, note: AUTO_NOTE })),
      skipDuplicates: true,
    });
    created += r.count;
  }
  if (created) await audit({ actorName: "Sistem (terjadwal)" }, "ABSEN_TANPA_KETERANGAN", "Attendance", null, { created, upTo: addDays(today, -1) });
  return { created };
}
