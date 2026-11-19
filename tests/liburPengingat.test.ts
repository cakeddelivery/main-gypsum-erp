import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { cancelDayOff, dayOffError, dayOffWindow, decideDayOff, mondayOf, submitDayOff } from "@/lib/dayOff";
import { checkInDue, checkInText, dueReminders, reportDue, reportText } from "@/lib/shiftReminders";
import { targetStatus } from "@/lib/attendanceRules";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
// 2032-05-10 = Senin; Jumat = 05-14; Sabtu = 05-15
const WED = "2032-05-12";

describe("Libur minggu depan (murni)", () => {
  it("minggu depan = Senin–Minggu berikutnya; batas Jumat 23.59 WIB", () => {
    expect(mondayOf(WED)).toBe("2032-05-10");
    expect(dayOffWindow(WED)).toEqual({ weekStart: "2032-05-17", weekEnd: "2032-05-23", deadline: "2032-05-14", open: true });
    expect(dayOffWindow("2032-05-14").open).toBe(true); // Jumat masih boleh
    expect(dayOffWindow("2032-05-15").open).toBe(false); // Sabtu terlambat
    expect(dayOffWindow("2032-05-16").open).toBe(false); // Minggu terlambat
    expect(dayOffWindow("2032-05-17")).toMatchObject({ weekStart: "2032-05-24", open: true }); // Senin: pengajuan untuk minggu berikutnya lagi
  });
  it("isian: harus di minggu depan, minimal 1 hari, setelah Jumat ditolak dengan pesan", () => {
    expect(dayOffError({ dates: ["2032-05-18"] }, WED)).toBeNull();
    expect(dayOffError({ dates: [] }, WED)).toMatch(/minimal/);
    expect(dayOffError({ dates: ["2032-05-13"] }, WED)).toMatch(/minggu depan/);
    expect(dayOffError({ dates: ["2032-05-24"] }, WED)).toMatch(/minggu depan/);
    expect(dayOffError({ dates: ["2032-05-18"] }, "2032-05-15")).toMatch(/Batas pengajuan/);
    expect(dayOffError({ dates: [], none: true }, WED)).toBeNull();
  });
  it("hari libur disetujui → LIBUR walau minggu itu belum ada jadwal; tetap Alpa bila dijadwalkan lagi", () => {
    const base = { scheduled: false, weekPlanned: false, leave: null, att: null };
    expect(targetStatus({ ...base, dayOff: true })?.status).toBe("LIBUR");
    expect(targetStatus({ ...base, scheduled: true, dayOff: true })?.status).toBe("ALPA");
    expect(targetStatus(base)?.status).toBe("ALPA");
  });
});

describe("Pengingat masuk & laporan (murni)", () => {
  const s1 = { id: "s1", name: "Shift 1", startTime: "07:00", endTime: "15:00" };
  const s2 = { id: "s2", name: "Shift 2", startTime: "16:00", endTime: "01:00" };
  it("masuk: 30 menit sebelum mulai sampai selesai; tidak lebih awal", () => {
    expect(checkInDue(jakartaDateTime("2032-05-12", "06:29"), "2032-05-12", s1)).toBe(false);
    expect(checkInDue(jakartaDateTime("2032-05-12", "06:30"), "2032-05-12", s1)).toBe(true);
    expect(checkInDue(jakartaDateTime("2032-05-12", "15:00"), "2032-05-12", s1)).toBe(false);
    expect(checkInText(jakartaDateTime("2032-05-12", "06:30"), "2032-05-12", s1).body).toBe("Shift 1 mulai 07:00, 30 menit lagi. Jangan lupa absen masuk.");
  });
  it("laporan: 30 menit sebelum selesai; Shift 2 lintas tengah malam", () => {
    expect(reportDue(jakartaDateTime("2032-05-12", "14:29"), "2032-05-12", s1)).toBe(false);
    expect(reportDue(jakartaDateTime("2032-05-12", "14:30"), "2032-05-12", s1)).toBe(true);
    expect(reportDue(jakartaDateTime("2032-05-13", "00:30"), "2032-05-12", s2)).toBe(true); // S2 tgl 12 selesai 01:00 tgl 13
    expect(reportDue(jakartaDateTime("2032-05-12", "23:59"), "2032-05-12", s2)).toBe(false);
    expect(reportText("Packing").body).toBe("Kirim laporan shift Packing sebelum pulang.");
  });
});

describe("Libur minggu depan & pengingat: alur database", () => {
  async function setup(code: string, role: "OPERATOR" | "SUPERVISOR" = "OPERATOR") {
    const div = await prisma.division.findFirstOrThrow({ where: { active: true, reportTemplate: { not: null } } });
    const emp = await prisma.employee.create({ data: { code: `LBR-${code}-${tag}`, name: `Libur ${code} ${tag}`, divisionId: div.id, joinDate: dateOnly("2031-01-01") } });
    const u = await prisma.user.create({ data: { username: `lbr-${code.toLowerCase()}-${tag.toLowerCase()}`, name: emp.name, role, passwordHash: "x", employeeId: emp.id } });
    return { emp, div, actor: { id: u.id, name: u.name, role: u.role, employeeId: emp.id } };
  }
  const now = jakartaDateTime(WED, "09:00");

  it("ajukan → setujui menghapus jadwal hari itu; tidak boleh dobel; setelah Jumat ditolak; sudah absen masuk dibiarkan", async () => {
    const { emp, actor } = await setup("A");
    const sup = await setup("S", "SUPERVISOR");
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    for (const d of ["2032-05-18", "2032-05-19", "2032-05-20"]) await prisma.shiftSchedule.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly(d) } });
    await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly("2032-05-20"), checkIn: new Date(), status: "HADIR" } });

    await expect(submitDayOff(actor, { dates: ["2032-05-18"] }, jakartaDateTime("2032-05-15", "10:00"))).rejects.toThrow(/Batas pengajuan/);
    const r = await submitDayOff(actor, { dates: ["2032-05-18", "2032-05-20"], reason: "Acara" }, now);
    expect(r.status).toBe("MENUNGGU");
    await expect(submitDayOff(actor, { dates: ["2032-05-19"] }, now)).rejects.toThrow(/sudah mengajukan/);
    await expect(decideDayOff(actor, r.id, true)).rejects.toThrow(/Supervisor atau Owner/);
    await expect(decideDayOff(sup.actor, r.id, false, " ")).rejects.toThrow(/alasan/i);

    const res = await decideDayOff(sup.actor, r.id, true);
    expect(res.removed).toBe(1); // 18 dihapus; 20 sudah absen masuk dibiarkan
    const left = (await prisma.shiftSchedule.findMany({ where: { employeeId: emp.id } })).map((x) => x.date.toISOString().slice(0, 10)).sort();
    expect(left).toEqual(["2032-05-19", "2032-05-20"]);
    await expect(decideDayOff(sup.actor, r.id, true)).rejects.toThrow(/sudah diputuskan/);
    await expect(cancelDayOff(actor, r.id)).rejects.toThrow(/sudah diputuskan/);
  });

  it("ditolak dengan alasan; 'tidak libur' langsung tercatat dan bisa dibatalkan", async () => {
    const { actor } = await setup("B");
    const sup = await setup("T", "SUPERVISOR");
    const r = await submitDayOff(actor, { dates: ["2032-05-21"] }, now);
    await decideDayOff(sup.actor, r.id, false, "Kekurangan orang");
    expect((await prisma.dayOffRequest.findUniqueOrThrow({ where: { id: r.id } })).rejectReason).toBe("Kekurangan orang");
    const n = await submitDayOff(actor, { dates: [], none: true }, now); // setelah ditolak boleh mengajukan lagi
    expect(n.status).toBe("DISETUJUI");
    await cancelDayOff(actor, n.id);
    expect(await prisma.dayOffRequest.count({ where: { id: n.id } })).toBe(0);
  });

  it("pengingat: masuk hanya yang dijadwalkan & belum absen; laporan hanya yang sudah absen masuk & laporan belum terkirim", async () => {
    const a = await setup("C");
    const b = await setup("D");
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const day = "2032-06-02";
    await prisma.shiftSchedule.createMany({ data: [a, b].map((x) => ({ employeeId: x.emp.id, shiftId: shift.id, date: dateOnly(day) })) });
    const before = jakartaDateTime(day, shift.startTime.slice(0, 5)).getTime() - 20 * 60000;
    const masuk = (await dueReminders(new Date(before), a.emp.id)).filter((x) => x.kind === "MASUK");
    expect(masuk).toHaveLength(1);
    expect(masuk[0].body).toMatch(/Jangan lupa absen masuk/);
    // b sudah absen masuk → tidak diingatkan masuk
    await prisma.attendance.create({ data: { employeeId: b.emp.id, shiftId: shift.id, date: dateOnly(day), checkIn: new Date(before), status: "HADIR" } });
    expect((await dueReminders(new Date(before), b.emp.id)).filter((x) => x.kind === "MASUK")).toHaveLength(0);
    // a libur (izin) → tidak diingatkan
    await prisma.attendance.create({ data: { employeeId: a.emp.id, shiftId: shift.id, date: dateOnly(day), status: "IZIN", note: "x" } });
    expect(await dueReminders(new Date(before), a.emp.id)).toHaveLength(0);
    // laporan: b absen masuk, menjelang selesai, laporan divisi belum terkirim
    const end = jakartaDateTime(day, shift.endTime.slice(0, 5)).getTime();
    const near = new Date(end - 20 * 60000);
    const lap = (await dueReminders(near, b.emp.id)).filter((x) => x.kind === "LAPORAN");
    expect(lap).toHaveLength(1);
    expect(lap[0].body).toBe(`Kirim laporan shift ${b.div.name} sebelum pulang.`);
    // sudah terkirim → hilang
    await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: b.div.id, status: "TERKIRIM", createdBy: "t" } });
    expect((await dueReminders(near, b.emp.id)).filter((x) => x.kind === "LAPORAN")).toHaveLength(0);
  });

  it("08.00: jadwal kerja harian untuk yang dijadwalkan; libur minggu depan HANYA Jumat (klik → halaman pengajuan)", async () => {
    const a = await setup("E");
    const c = await setup("F"); // tidak dijadwalkan
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const thu = "2032-06-03"; // Kamis
    await prisma.shiftSchedule.create({ data: { employeeId: a.emp.id, shiftId: shift.id, date: dateOnly(thu) } });
    const at = jakartaDateTime(thu, "08:00");
    const mine = await dueReminders(at, a.emp.id);
    expect(mine.filter((x) => x.kind === "LIBUR")).toHaveLength(0); // bukan Jumat
    const j = mine.filter((x) => x.kind === "JADWAL" || x.kind === "MASUK");
    expect(j).toHaveLength(1); // tidak dobel dengan pengingat 30 menit
    if (j[0].kind === "JADWAL") expect(j[0].body).toBe(`Jadwal kerja hari ini: ${shift.name} ${shift.startTime}–${shift.endTime} · jangan lupa absen masuk`);
    expect(await dueReminders(at, c.emp.id)).toHaveLength(0); // tidak dijadwalkan
    expect((await dueReminders(jakartaDateTime(thu, "07:59"), a.emp.id)).filter((x) => x.kind === "JADWAL")).toHaveLength(0); // belum 08.00

    const fri = "2032-06-04";
    const l = await dueReminders(jakartaDateTime(fri, "08:00"), c.emp.id);
    expect(l.filter((x) => x.kind === "LIBUR")).toHaveLength(1);
    expect(l.find((x) => x.kind === "LIBUR")!.url).toBe("/absensi?tab=izin#libur");
    expect((await dueReminders(jakartaDateTime(fri, "07:59"), c.emp.id)).filter((x) => x.kind === "LIBUR")).toHaveLength(0);
    expect((await dueReminders(jakartaDateTime("2032-06-05", "09:00"), c.emp.id)).filter((x) => x.kind === "LIBUR")).toHaveLength(0); // Sabtu
    // sudah mengajukan → tidak diingatkan lagi
    await submitDayOff(c.actor, { dates: [], none: true }, jakartaDateTime(fri, "07:00"));
    expect((await dueReminders(jakartaDateTime(fri, "10:00"), c.emp.id)).filter((x) => x.kind === "LIBUR")).toHaveLength(0);
  });
});
