import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { carryOver, checkoutDiff, crossesMidnight, shiftWindow } from "@/lib/workday";
import { resolveWorkday, selfCheckIn, selfCheckOut } from "@/lib/attendanceSelf";
import { reconcileDay } from "@/lib/attendanceAuto";
import { applyNightFixes, applyNightReportFixes, findNightFixes, findNightReportFixes } from "@/lib/nightShiftFix";
import { reportSlot } from "@/components/ReportStartForm";
import { dateOnly, dateStr, jakartaDateTime } from "@/lib/time";

/**
 * Shift malam lintas hari (kasus produksi 16 Nov): Shift 2 Cetak/Oven 16:00–01:00.
 * TANGGAL KERJA = tanggal mulai shift; pulang 01:05 tetap milik tanggal kerja kemarin.
 */
const S1 = { startTime: "08:30", endTime: "17:30" };
const S2 = { startTime: "16:00", endTime: "01:00" };
const D = "2034-01-15"; // Minggu
const N = "2034-01-16"; // Senin (hari kalender berikutnya)
const at = (date: string, hhmm: string) => jakartaDateTime(date, hhmm);

describe("Tanggal kerja shift malam (murni)", () => {
  it("shift lintas tengah malam, jendela shift, pulang cepat & lembur", () => {
    expect(crossesMidnight(S2)).toBe(true);
    expect(crossesMidnight(S1)).toBe(false);
    expect(shiftWindow(D, S2).end.toISOString()).toBe(at(N, "01:00").toISOString());
    expect(checkoutDiff(D, S2, at(N, "01:05"))).toEqual({ earlyMinutes: 0, overtimeMinutes: 5 });
    expect(checkoutDiff(D, S2, at(N, "00:30"))).toEqual({ earlyMinutes: 30, overtimeMinutes: 0 });
    expect(checkoutDiff(D, S2, at(D, "23:00"))).toEqual({ earlyMinutes: 120, overtimeMinutes: 0 });
    expect(checkoutDiff(D, S1, at(D, "17:00"))).toEqual({ earlyMinutes: 30, overtimeMinutes: 0 });
  });

  it("halaman dibuka 00:30 / 01:03 / 06:30 → absen pulang tanggal kerja kemarin; 07:30 → hari baru", () => {
    const open = { att: { checkIn: at(D, "15:58"), checkOut: null, shift: S2 }, sched: { shift: S2 } };
    expect(carryOver(at(N, "00:30"), D, open)).toBe("pulang");
    expect(carryOver(at(N, "01:03"), D, open)).toBe("pulang");
    expect(carryOver(at(N, "06:30"), D, open)).toBe("pulang");
    expect(carryOver(at(N, "07:30"), D, open)).toBeNull();
    // Sudah pulang 01:05: kartu selesai sebentar, lalu hari baru
    const done = { ...open, att: { ...open.att, checkOut: at(N, "01:05") } };
    expect(carryOver(at(N, "01:30"), D, done)).toBe("selesai");
    expect(carryOver(at(N, "06:30"), D, done)).toBeNull();
    // Belum absen sama sekali, jadwal kemarin S2: 00:30 masih di jam shift (datang telat), 01:30 sudah lewat
    const sched = { att: null, sched: { shift: S2 } };
    expect(carryOver(at(N, "00:30"), D, sched)).toBe("masuk");
    expect(carryOver(at(N, "01:30"), D, sched)).toBeNull();
    // Non-shift / shift siang yang lupa pulang tidak terpengaruh
    expect(carryOver(at(N, "01:03"), D, { att: { checkIn: at(D, "08:25"), checkOut: null, shift: S1 }, sched: { shift: S1 } })).toBeNull();
    expect(carryOver(at(N, "00:30"), D, { att: null, sched: { shift: S1 } })).toBeNull();
  });
});

describe("Tanggal laporan shift malam (murni)", () => {
  const shifts = [{ id: "s1", name: "Shift 1", ...S1 }, { id: "s2", name: "Shift 2", ...S2 }];
  const at2 = (h: number, m: number) => new Date(2034, 0, 16, h, m);
  it("lewat tengah malam s.d. 07:00 → Shift 2 tanggal kemarin; siang → hari ini; non-shift tidak terpengaruh", () => {
    expect(reportSlot(shifts, N, at2(1, 3))).toEqual({ shift: shifts[1], date: D });
    expect(reportSlot(shifts, N, at2(0, 30))).toEqual({ shift: shifts[1], date: D });
    expect(reportSlot(shifts, N, at2(6, 30))).toEqual({ shift: shifts[1], date: D });
    expect(reportSlot(shifts, N, at2(9, 0))).toEqual({ shift: shifts[0], date: N });
    expect(reportSlot(shifts, N, at2(18, 0))).toEqual({ shift: shifts[1], date: N });
    expect(reportSlot([shifts[0]], N, at2(1, 3)).date).toBe(N);
  });
});

describe("Absen shift malam di database (web & bot memakai fungsi yang sama)", () => {
  const tag = Date.now().toString(36).slice(-5).toUpperCase();
  let restore: () => Promise<void> = async () => {};
  let s1Id = "";
  let s2Id = "";
  let n = 0;

  beforeAll(async () => {
    const [s1, s2] = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
    s1Id = s1.id;
    s2Id = s2.id;
    const sites = await prisma.workSite.findMany({ where: { active: true }, select: { id: true } });
    // Jam shift seperti produksi; titik lokasi dinonaktifkan sementara (absen tanpa GPS diizinkan bila tidak ada titik)
    await prisma.shift.update({ where: { id: s1.id }, data: S1 });
    await prisma.shift.update({ where: { id: s2.id }, data: S2 });
    await prisma.workSite.updateMany({ where: { id: { in: sites.map((x) => x.id) } }, data: { active: false } });
    restore = async () => {
      await prisma.shift.update({ where: { id: s1.id }, data: { startTime: s1.startTime, endTime: s1.endTime } });
      await prisma.shift.update({ where: { id: s2.id }, data: { startTime: s2.startTime, endTime: s2.endTime } });
      await prisma.workSite.updateMany({ where: { id: { in: sites.map((x) => x.id) } }, data: { active: true } });
    };
  });
  afterAll(async () => {
    vi.useRealTimers();
    await restore();
  });
  afterEach(() => vi.useRealTimers());

  const setNow = (d: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d);
  };
  async function emp(divName: string, shiftCount: number) {
    const k = `${tag}${++n}`;
    const div = await prisma.division.create({ data: { code: `SM${k}`, name: `${divName} ${k}`, shiftCount } });
    const e = await prisma.employee.create({ data: { code: `SM-${k}`, name: `Malam ${divName} ${k}`, divisionId: div.id, joinDate: dateOnly("2033-01-01") } });
    return { e, actor: { id: `u-${k}`, name: e.name, employeeId: e.id } };
  }
  const row = (employeeId: string, date: string) => prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, include: { shift: true } });

  it("Cetak S2: masuk 15:58, buka 00:30 & 01:03 → pulang kemarin, pulang 01:05 → satu hari kerja, tidak telat", async () => {
    const { e, actor } = await emp("Cetak", 2);
    await prisma.shiftSchedule.create({ data: { employeeId: e.id, date: dateOnly(D), shiftId: s1Id } }); // jadwal S1, absen sore → S2

    setNow(at(D, "15:58"));
    const r = await selfCheckIn(actor, null);
    expect([r.shift, r.status, r.lateMinutes, r.date]).toEqual(["Shift 2", "HADIR", 0, D]);

    setNow(at(N, "00:30"));
    expect(await resolveWorkday(e.id)).toEqual({ date: D, carried: "pulang" });
    setNow(at(N, "01:03"));
    expect(await resolveWorkday(e.id)).toEqual({ date: D, carried: "pulang" });
    // Menekan absen masuk (mis. lewat bot) ditolak: masih di shift malam kemarin
    await expect(selfCheckIn(actor, null)).rejects.toThrow(/shift malam/);

    setNow(at(N, "01:05"));
    const out = await selfCheckOut(actor, null);
    expect([out.date, out.overtimeMinutes, out.earlyMinutes]).toEqual([D, 5, 0]);

    const a = await row(e.id, D);
    expect([a?.shift.code, a?.status, a?.lateMinutes, a?.checkOut?.toISOString()]).toEqual(["S2", "HADIR", 0, at(N, "01:05").toISOString()]);
    expect(await row(e.id, N)).toBeNull(); // tidak ada hari ganda
    expect((await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(D) } } }))?.shiftId).toBe(s2Id);

    setNow(at(N, "01:30"));
    expect((await resolveWorkday(e.id)).carried).toBe("selesai");
    setNow(at(N, "06:30"));
    expect(await resolveWorkday(e.id)).toEqual({ date: N, carried: null });
  });

  it("Oven S2: lupa pulang, dibuka 06:30 → masih absen pulang tanggal kerja kemarin (lembur dihitung lewat 00:00)", async () => {
    const { e, actor } = await emp("Oven", 2);
    setNow(at(D, "16:08"));
    const r = await selfCheckIn(actor, null);
    expect([r.shift, r.status, r.date]).toEqual(["Shift 2", "HADIR", D]);
    setNow(at(N, "06:30"));
    expect(await resolveWorkday(e.id)).toEqual({ date: D, carried: "pulang" });
    const out = await selfCheckOut(actor, null);
    expect([out.date, out.overtimeMinutes]).toEqual([D, 330]);
  });

  it("Divisi 1 shift tidak terpengaruh: lupa pulang kemarin, 01:03 tetap hari baru", async () => {
    const { e, actor } = await emp("Kantor", 1);
    await prisma.shiftSchedule.create({ data: { employeeId: e.id, date: dateOnly(D), shiftId: s1Id } });
    setNow(at(D, "08:25"));
    expect((await selfCheckIn(actor, null)).shift).toBe("Shift 1");
    setNow(at(N, "01:03"));
    expect(await resolveWorkday(e.id)).toEqual({ date: N, carried: null });
    await expect(selfCheckOut(actor, null)).rejects.toThrow("Belum absen masuk");
  });

  it("Datang telat ke shift malam (00:30) tetap tanggal kerja kemarin; job tidak menandai Alpa selama shift berjalan", async () => {
    const { e, actor } = await emp("Cetak", 2);
    const late = await emp("Cetak", 2);
    for (const x of [e, late.e]) await prisma.shiftSchedule.create({ data: { employeeId: x.id, date: dateOnly(D), shiftId: s2Id } });

    // 00:20: shift S2 tanggal D masih berjalan → belum Alpa
    expect(await reconcileDay(D, { apply: true, employeeIds: [e.id, late.e.id], now: at(N, "00:20") })).toEqual([]);

    setNow(at(N, "00:30"));
    const r = await selfCheckIn(late.actor, null);
    expect([r.date, r.shift, r.status, r.lateMinutes]).toEqual([D, "Shift 2", "TERLAMBAT", 510]);
    expect(await row(late.e.id, N)).toBeNull();
    vi.useRealTimers();

    // 06:00: shift selesai → yang tidak absen jadi Alpa; yang datang telat tetap S2 (tidak digeser ke S1)
    await reconcileDay(D, { apply: true, employeeIds: [e.id, late.e.id], now: at(N, "06:00") });
    expect((await row(e.id, D))?.status).toBe("ALPA");
    const lr = await row(late.e.id, D);
    expect([lr?.shift.code, lr?.status]).toEqual(["S2", "TERLAMBAT"]);
    void actor;
  });

  it("Skrip perbaikan: 'absen masuk' 01:03 hari baru dipindah menjadi absen pulang tanggal kerja kemarin", async () => {
    const { e } = await emp("Cetak", 2);
    const prev = await prisma.attendance.create({ data: { employeeId: e.id, date: dateOnly(D), shiftId: s2Id, checkIn: at(D, "15:58"), status: "HADIR", checkInLat: -7.1, checkInLng: 112.1 } });
    const wrong = await prisma.attendance.create({ data: { employeeId: e.id, date: dateOnly(N), shiftId: s1Id, checkIn: at(N, "01:03"), status: "HADIR", checkInLat: -7.2, checkInLng: 112.2 } });
    // Shift siang lain yang lupa pulang tidak ikut tersentuh
    const other = await emp("Kantor", 1);
    await prisma.attendance.create({ data: { employeeId: other.e.id, date: dateOnly(D), shiftId: s1Id, checkIn: at(D, "08:30"), status: "HADIR" } });
    await prisma.attendance.create({ data: { employeeId: other.e.id, date: dateOnly(N), shiftId: s1Id, checkIn: at(N, "08:30"), status: "HADIR" } });

    const fixes = (await findNightFixes(14, at(N, "09:00"))).filter((f) => [e.id, other.e.id].includes(f.employeeId));
    expect(fixes.map((f) => [f.attId, f.prevId])).toEqual([[wrong.id, prev.id]]);
    expect(await prisma.attendance.count({ where: { id: wrong.id } })).toBe(1); // pratinjau tidak menyimpan

    await applyNightFixes(fixes);
    const fixed = await prisma.attendance.findUniqueOrThrow({ where: { id: prev.id } });
    expect([fixed.checkOut?.toISOString(), fixed.checkOutLat]).toEqual([at(N, "01:03").toISOString(), -7.2]);
    expect(await prisma.attendance.count({ where: { id: wrong.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "ABSEN_SHIFT_MALAM_DIPERBAIKI", entityId: prev.id } })).toBe(1);
  });

  it("Skrip perbaikan: laporan Shift 2 yang dibuka 01:10 dipindah ke tanggal mulai shift; bentrok tidak dipindah", async () => {
    const k = `${tag}R`;
    const div = await prisma.division.create({ data: { code: `LR${k}`, name: `Cetak Lap ${k}`, shiftCount: 2 } });
    const div2 = await prisma.division.create({ data: { code: `LB${k}`, name: `Oven Lap ${k}`, shiftCount: 2 } });
    const wrong = await prisma.shiftReport.create({ data: { date: dateOnly(N), shiftId: s2Id, divisionId: div.id, createdBy: "uji", createdAt: at(N, "01:10") } });
    // Laporan Shift 2 sungguhan tanggal N (dibuka sore) tidak tersentuh
    const real = await prisma.shiftReport.create({ data: { date: dateOnly(N), shiftId: s1Id, divisionId: div.id, createdBy: "uji", createdAt: at(N, "08:40") } });
    // Bentrok: tanggal D sudah punya laporan divisi & shift yang sama
    await prisma.shiftReport.create({ data: { date: dateOnly(D), shiftId: s2Id, divisionId: div2.id, createdBy: "uji", createdAt: at(D, "16:05") } });
    const clash = await prisma.shiftReport.create({ data: { date: dateOnly(N), shiftId: s2Id, divisionId: div2.id, createdBy: "uji", createdAt: at(N, "01:20") } });
    const fixes = (await findNightReportFixes(14, at(N, "09:00"))).filter((f) => [wrong.id, real.id, clash.id].includes(f.id)).sort((a, b) => Number(!!a.conflictWith) - Number(!!b.conflictWith));
    expect(fixes.map((f) => [f.id, f.to, !!f.conflictWith])).toEqual([[wrong.id, D, false], [clash.id, D, true]]);
    expect(await applyNightReportFixes(fixes)).toBe(1);
    expect(dateStr((await prisma.shiftReport.findUniqueOrThrow({ where: { id: wrong.id } })).date)).toBe(D);
    expect(dateStr((await prisma.shiftReport.findUniqueOrThrow({ where: { id: clash.id } })).date)).toBe(N);
  });

});
