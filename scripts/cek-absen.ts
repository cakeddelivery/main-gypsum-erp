/*
 * Diagnosa absensi (HANYA MEMBACA, tidak mengubah data):
 *   npm run cek:absen -- --nama=Bagus --tanggal=2025-11-18
 * Menampilkan jadwal, absen, riwayat aktivitas, dan hasil simulasi "tanggal kerja" di jam 00:30 / 00:59 / 01:00 / 01:05 / 06:59 / 07:01.
 */
import { prisma } from "../src/lib/db";
import { workdayFor } from "../src/lib/workday";
import { addDays, dateOnly, jakartaDateTime } from "../src/lib/time";
import { isShiftDivision } from "../src/lib/attendanceRules";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const nama = arg("nama");
const tgl = arg("tanggal");
if (!nama || !tgl) {
  console.log("Pemakaian: npm run cek:absen -- --nama=Bagus --tanggal=2025-11-18");
  process.exit(1);
}
const wib = (d: Date | null | undefined) => (d ? d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-");

(async () => {
  const emps = await prisma.employee.findMany({ where: { name: { contains: nama, mode: "insensitive" } }, include: { division: true } });
  if (!emps.length) return console.log("Karyawan tidak ditemukan");
  for (const e of emps) {
    console.log(`\n== ${e.name} (${e.code}) · divisi ${e.division?.name} · shiftCount ${e.division?.shiftCount}`);
    const shifts = await prisma.shift.findMany({ orderBy: { code: "asc" } });
    console.log("Shift:", shifts.map((s) => `${s.code} ${s.startTime}-${s.endTime}${s.active ? "" : " (nonaktif)"}`).join(" | "));
    for (const d of [tgl, addDays(tgl, 1)]) {
      const [att, sch] = await Promise.all([
        prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(d) } }, include: { shift: true } }),
        prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(d) } }, include: { shift: true } }),
      ]);
      console.log(`${d}: jadwal=${sch?.shift.code ?? "-"} · absen=${att ? `${att.shift.code} masuk ${wib(att.checkIn)} pulang ${wib(att.checkOut)} status ${att.status} catatan ${att.note ?? "-"}` : "tidak ada"}`);
    }
    const logs = await prisma.auditLog.findMany({ where: { OR: [{ entityId: e.id }, { actorName: e.name }], at: { gte: jakartaDateTime(tgl, "00:00"), lt: jakartaDateTime(addDays(tgl, 3), "00:00") } }, orderBy: { at: "asc" }, take: 30 });
    for (const l of logs) console.log(`  [${wib(l.at)}] ${l.action} ${JSON.stringify(l.data ?? {}).slice(0, 160)}`);
    const att = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(tgl) } }, include: { shift: true } });
    const sched = await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(tgl) } }, include: { shift: true } });
    const next = addDays(tgl, 1);
    console.log("Simulasi tanggal kerja (jam WIB tanggal " + next + "):");
    for (const t of ["00:30", "00:59", "01:00", "01:05", "06:59", "07:01"]) {
      const r = workdayFor(jakartaDateTime(next, t), { att, sched, shiftDivision: !!e.division && isShiftDivision(e.division) });
      console.log(`  ${t} → tanggal kerja ${r.date}, status ${r.carried ?? "hari baru (absen pulang gagal: 'Belum absen masuk')"}`);
    }
  }
})().catch((x) => { console.error(x); process.exitCode = 1; }).finally(() => prisma.$disconnect());
