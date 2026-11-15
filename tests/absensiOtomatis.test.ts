import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { AUTO_NOTE, LIBUR_NOTE, actualShift, targetStatus } from "@/lib/attendanceRules";
import { reconcileAfterSchedule, reconcileDay } from "@/lib/attendanceAuto";
import { resolveAttendanceBacklog } from "@/lib/attendanceBacklog";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();

describe("Aturan status otomatis (murni)", () => {
  const none = { scheduled: false, weekPlanned: false, leave: null, att: null };
  it("jadwal + absen + izin → status final", () => {
    expect(targetStatus({ ...none, scheduled: true, weekPlanned: true })).toEqual({ status: "ALPA", note: AUTO_NOTE });
    expect(targetStatus({ ...none, weekPlanned: true })).toEqual({ status: "LIBUR", note: LIBUR_NOTE });
    expect(targetStatus(none)).toEqual({ status: "ALPA", note: AUTO_NOTE }); // minggu belum diatur
    expect(targetStatus({ ...none, scheduled: true, leave: "SAKIT" })?.status).toBe("SAKIT");
    expect(targetStatus({ ...none, scheduled: true, att: { status: "HADIR", checkIn: new Date(), note: null } })).toBeNull();
    // Koreksi manual tidak ditimpa; status otomatis lama boleh dihitung ulang
    expect(targetStatus({ ...none, scheduled: true, att: { status: "IZIN", checkIn: null, note: "Koreksi SPV: izin" } })).toBeNull();
    expect(targetStatus({ ...none, weekPlanned: true, att: { status: "ALPA", checkIn: null, note: AUTO_NOTE } })?.status).toBe("LIBUR");
  });

  it("shift sebenarnya: divisi 2 shift ikut jam absen, divisi 1 shift ikut jadwal", () => {
    const s = [{ id: "s1", startTime: "07:00" }, { id: "s2", startTime: "15:00" }];
    const at = jakartaDateTime("2033-03-07", "15:04");
    expect(actualShift(s, at, "s1", true)?.id).toBe("s2");
    expect(actualShift(s, jakartaDateTime("2033-03-07", "07:20"), "s2", true)?.id).toBe("s1");
    expect(actualShift(s, at, "s1", false)?.id).toBe("s1");
    expect(actualShift(s, at, null, false)?.id).toBe("s2");
  });
});

describe("Status otomatis di database", () => {
  let n = 0;
  async function setup() {
    const k = `${tag}${++n}`;
    const [s1, s2] = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
    const one = await prisma.division.create({ data: { code: `O1${k}`, name: `Divisi Satu ${k}`, shiftCount: 1 } });
    const two = await prisma.division.create({ data: { code: `O2${k}`, name: `Divisi Cetak ${k}`, shiftCount: 2 } });
    const mk = (x: string, divisionId: string) => prisma.employee.create({ data: { code: `OTO-${x}-${k}`, name: `Oto ${x} ${k}`, divisionId, joinDate: dateOnly("2033-01-01") } });
    return { s1, s2, one, two, mk };
  }
  const day = "2033-03-08"; // Selasa; minggu 7–13 Maret 2033
  const sched = (employeeId: string, date: string, shiftId: string) => prisma.shiftSchedule.create({ data: { employeeId, date: dateOnly(date), shiftId } });

  it("Alpa/Libur/Izin/minggu tanpa jadwal; Cetak absen di shift lain → shift & jadwal ikut; absen tanpa jadwal → jadwal dicentang", async () => {
    const { s1, s2, one, two, mk } = await setup();
    const masukAbsen = await mk("A", one.id);
    const masukTanpa = await mk("B", one.id);
    const libur = await mk("C", one.id);
    const tanpaMinggu = await mk("D", one.id);
    const izin = await mk("E", one.id);
    const cetak = await mk("F", two.id);
    const absenTanpaJadwal = await mk("G", one.id);
    await sched(masukAbsen.id, day, s1.id);
    await sched(masukTanpa.id, day, s1.id);
    await sched(libur.id, "2033-03-07", s1.id); // minggu terjadwal, Selasa tidak dicentang
    await sched(izin.id, day, s1.id);
    await sched(cetak.id, day, s1.id); // dijadwalkan S1, ternyata absen jam 15.04 (S2)
    await prisma.leaveRequest.create({ data: { employeeId: izin.id, kind: "IZIN", dateFrom: dateOnly(day), dateTo: dateOnly(day), reason: "Urusan keluarga", status: "DISETUJUI" } });
    const att = (employeeId: string, shiftId: string, hhmm: string, status: "HADIR" | "TERLAMBAT", late: number) =>
      prisma.attendance.create({ data: { employeeId, date: dateOnly(day), shiftId, checkIn: jakartaDateTime(day, hhmm), status, lateMinutes: late } });
    await att(masukAbsen.id, s1.id, "07:15", "TERLAMBAT", 15);
    await att(cetak.id, s1.id, "15:04", "TERLAMBAT", 484);
    await att(absenTanpaJadwal.id, s1.id, "07:00", "HADIR", 0);

    const ids = [masukAbsen, masukTanpa, libur, tanpaMinggu, izin, cetak, absenTanpaJadwal].map((e) => e.id);
    const preview = await reconcileDay(day, { apply: false, employeeIds: ids });
    expect(await prisma.attendance.count({ where: { employeeId: { in: ids } } })).toBe(3); // pratinjau tidak menyimpan
    expect(preview.length).toBeGreaterThan(0);
    await reconcileDay(day, { apply: true, employeeIds: ids });

    const rows = await prisma.attendance.findMany({ where: { employeeId: { in: ids } }, include: { shift: true } });
    const of = (id: string) => rows.find((r) => r.employeeId === id)!;
    expect([of(masukAbsen.id).status, of(masukAbsen.id).lateMinutes]).toEqual(["TERLAMBAT", 15]);
    expect(of(masukTanpa.id).status).toBe("ALPA");
    expect([of(libur.id).status, of(libur.id).note]).toEqual(["LIBUR", LIBUR_NOTE]);
    expect(of(tanpaMinggu.id).status).toBe("ALPA");
    expect(of(izin.id).status).toBe("IZIN");
    // Cetak: shift & telat mengikuti jam absen (S2 mulai 15.00, telat 4 menit ≤ toleransi → Hadir), jadwal ikut S2
    expect([of(cetak.id).shift.code, of(cetak.id).status, of(cetak.id).lateMinutes]).toEqual([s2.code, "HADIR", 4]);
    expect((await prisma.shiftSchedule.findUniqueOrThrow({ where: { employeeId_date: { employeeId: cetak.id, date: dateOnly(day) } } })).shiftId).toBe(s2.id);
    // Absen tanpa jadwal: tetap Hadir, jadwal hari itu diisi otomatis
    expect(of(absenTanpaJadwal.id).status).toBe("HADIR");
    expect(await prisma.shiftSchedule.count({ where: { employeeId: absenTanpaJadwal.id, date: dateOnly(day) } })).toBe(1);
    // Semua langsung tervalidasi (tidak ada antrean) & tercatat di audit log
    expect(rows.every((r) => r.validated)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "ABSEN_OTOMATIS_" }, entityId: { startsWith: cetak.id } } })).toBeGreaterThan(0);
    // Aman diulang
    expect(await reconcileDay(day, { apply: true, employeeIds: ids })).toEqual([]);

    // Jadwal diubah setelahnya: yang tadinya dijadwalkan masuk (Alpa) jadi tidak dicentang → Libur; koreksi manual tidak ditimpa
    await prisma.shiftSchedule.deleteMany({ where: { employeeId: masukTanpa.id, date: dateOnly(day) } });
    await sched(masukTanpa.id, "2033-03-09", s1.id);
    await prisma.attendance.update({ where: { employeeId_date: { employeeId: izin.id, date: dateOnly(day) } }, data: { note: "Koreksi SPV: izin dokter", status: "SAKIT" } });
    await reconcileAfterSchedule([day], [masukTanpa.id, izin.id], jakartaDateTime("2033-03-10", "06:00"));
    expect((await prisma.attendance.findUniqueOrThrow({ where: { employeeId_date: { employeeId: masukTanpa.id, date: dateOnly(day) } } })).status).toBe("LIBUR");
    expect((await prisma.attendance.findUniqueOrThrow({ where: { employeeId_date: { employeeId: izin.id, date: dateOnly(day) } } })).status).toBe("SAKIT");
  });

  it("antrean validasi lama diselesaikan: pratinjau dulu, lalu --jalankan; data tidak dihapus", async () => {
    const { s1, one, mk } = await setup();
    const a = await mk("Q1", one.id);
    const b = await mk("Q2", one.id);
    const d = "2033-04-05";
    await sched(b.id, "2033-04-04", s1.id); // minggu terjadwal
    await prisma.attendance.create({ data: { employeeId: a.id, date: dateOnly(d), shiftId: s1.id, checkIn: jakartaDateTime(d, "07:02"), status: "HADIR" } });
    await prisma.attendance.create({ data: { employeeId: b.id, date: dateOnly(d), shiftId: s1.id, status: "ALPA", note: AUTO_NOTE } });
    const now = jakartaDateTime("2033-04-10", "09:00");
    const pre = await resolveAttendanceBacklog(false, now);
    expect(pre.lines.some((l) => l.includes(b.name) && l.includes("ALPA → LIBUR"))).toBe(true);
    expect(await prisma.attendance.count({ where: { employeeId: { in: [a.id, b.id] }, validated: false } })).toBe(2);
    await resolveAttendanceBacklog(true, now);
    const rows = await prisma.attendance.findMany({ where: { employeeId: { in: [a.id, b.id] } } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.validated)).toBe(true);
    expect(rows.find((r) => r.employeeId === b.id)?.status).toBe("LIBUR");
    expect(rows.find((r) => r.employeeId === a.id)?.status).toBe("HADIR");
  });
});
