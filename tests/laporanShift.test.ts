import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { applyReportShiftFixes, assertMemberOwnsReport, findReportShiftMismatches, memberReportSlot, moveReportShift } from "@/lib/reportShift";
import { dateOnly, jakartaDateTime } from "@/lib/time";

/** Shift laporan mengikuti absen pelapor: Shift 1 tidak bisa melapor Shift 2 (kasus Cetak 18 Nov) */
const D = "2035-03-14";
const N = "2035-03-15";
const at = (d: string, h: string) => jakartaDateTime(d, h);
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const actor = { id: "t", name: "Tes" };
let s1 = "", s2 = "", divId = "", n = 0;
let restore: () => Promise<void> = async () => {};

beforeAll(async () => {
  const [a, b] = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  s1 = a.id; s2 = b.id;
  await prisma.shift.update({ where: { id: a.id }, data: { startTime: "08:30", endTime: "17:30" } });
  await prisma.shift.update({ where: { id: b.id }, data: { startTime: "16:00", endTime: "01:00" } });
  restore = async () => {
    await prisma.shift.update({ where: { id: a.id }, data: { startTime: a.startTime, endTime: a.endTime } });
    await prisma.shift.update({ where: { id: b.id }, data: { startTime: b.startTime, endTime: b.endTime } });
  };
  divId = (await prisma.division.create({ data: { code: `LS${tag}`, name: `Cetak Lap ${tag}`, shiftCount: 2 } })).id;
});
afterAll(async () => { vi.useRealTimers(); await restore(); });
afterEach(() => vi.useRealTimers());
const setNow = (d: Date) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(d); };
async function emp() {
  const k = `${tag}${++n}`;
  const e = await prisma.employee.create({ data: { code: `LS-${k}`, name: `Lap ${k}`, divisionId: divId, joinDate: dateOnly("2034-01-01") } });
  return e;
}
const absen = (employeeId: string, date: string, shiftId: string, hhmm: string) => prisma.attendance.create({ data: { employeeId, date: dateOnly(date), shiftId, checkIn: at(date, hhmm), status: "HADIR", validated: true } });
const report = (date: string, shiftId: string, picName: string, status: "DRAFT" | "TERKIRIM" = "DRAFT") => prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId, divisionId: divId, picName, status, createdBy: picName } });

describe("Shift laporan mengikuti absen", () => {
  it("A: slot laporan = shift & tanggal absen; belum absen → diarahkan absen", async () => {
    const e = await emp();
    setNow(at(D, "17:41"));
    await expect(memberReportSlot(e.id, divId)).rejects.toThrow(/belum absen masuk/);
    await absen(e.id, D, s1, "08:25");
    expect(await memberReportSlot(e.id, divId)).toEqual({ date: D, shiftId: s1 });
  });

  it("shift laporan TIDAK dari jam sekarang: absen S1 08:25 → 16:30 / 17:30 / 18:30 selalu Shift 1 (S1 & S2 tumpang tindih 16:00–17:30)", async () => {
    const rico = await emp();
    await absen(rico.id, D, s1, "08:25");
    for (const h of ["16:30", "17:30", "18:30", "23:50"]) {
      setNow(at(D, h));
      expect(await memberReportSlot(rico.id, divId)).toEqual({ date: D, shiftId: s1 });
    }
    // Laporan S1 yang belum terkirim masih bisa dikirim besok pagi sebelum absen masuk berikutnya
    setNow(at(N, "07:30"));
    expect(await memberReportSlot(rico.id, divId)).toEqual({ date: D, shiftId: s1 });
    // Setelah laporannya terkirim, tidak lagi dibuka kembali
    await prisma.shiftReport.create({ data: { date: dateOnly(D), shiftId: s1, divisionId: divId, picName: "rico", status: "TERKIRIM", createdBy: "rico" } });
    await expect(memberReportSlot(rico.id, divId)).rejects.toThrow(/belum absen masuk/);
  });

  it("B: karyawan Shift 1 tidak bisa mengisi laporan Shift 2; Shift 2 bisa; belum absen ditolak", async () => {
    const rico = await emp(), bagus = await emp(), belum = await emp();
    await absen(rico.id, D, s1, "08:25");
    await absen(bagus.id, D, s2, "15:58");
    const r2 = await report(D, s2, "bagus");
    const full = await prisma.shiftReport.findUniqueOrThrow({ where: { id: r2.id }, include: { shift: true } });
    await expect(assertMemberOwnsReport(rico.id, full)).rejects.toThrow(/absen Anda Shift 1|absen Anda/);
    await expect(assertMemberOwnsReport(belum.id, full)).rejects.toThrow(/belum absen masuk/);
    await expect(assertMemberOwnsReport(bagus.id, full)).resolves.toBeUndefined();
  });

  it("lintas tengah malam: S2 membuka laporan 00:30 & setelah pulang 01:10 → tetap tanggal kerja kemarin, Shift 2", async () => {
    const e = await emp();
    await absen(e.id, D, s2, "15:58");
    setNow(at(N, "00:30"));
    expect(await memberReportSlot(e.id, divId)).toEqual({ date: D, shiftId: s2 });
    await prisma.attendance.update({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(D) } }, data: { checkOut: at(N, "01:05") } });
    setNow(at(N, "01:10"));
    expect(await memberReportSlot(e.id, divId)).toEqual({ date: D, shiftId: s2 });
    setNow(at(N, "07:30")); // laporan belum terkirim tetap bisa dikirim sampai absen masuk berikutnya
    expect(await memberReportSlot(e.id, divId)).toEqual({ date: D, shiftId: s2 });
  });

  it("C: pindah laporan salah shift; bentrok ditolak; tukar saling menukar", async () => {
    const D2 = "2035-03-20";
    const wrong = await report(D2, s2, "rico", "TERKIRIM");
    const r = await moveReportShift(wrong.id, s1, "dikirim karyawan Shift 1", actor);
    expect([r.from, r.swapped]).toEqual(["Shift 2", false]);
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: wrong.id } })).shiftId).toBe(s1);
    expect(await prisma.auditLog.count({ where: { action: "LAPORAN_SHIFT_DIPINDAH", entityId: wrong.id } })).toBe(1);
    // bentrok
    const other = await report(D2, s2, "bagus");
    await expect(moveReportShift(other.id, s1, "coba", actor)).rejects.toThrow(/sudah punya laporan/);
    await expect(moveReportShift(other.id, s1, "", actor)).rejects.toThrow(/alasan/);
    // tukar
    await moveReportShift(other.id, s1, "tukar", actor, "tukar");
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: other.id } })).shiftId).toBe(s1);
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: wrong.id } })).shiftId).toBe(s2);
  });

  it("D: skrip mendeteksi laporan Shift 2 oleh PIC yang absen Shift 1 dan memindahkannya; bentrok hanya dilaporkan", async () => {
    const D3 = "2035-03-25", D4 = "2035-03-26";
    const user = async (e: { id: string }, name: string) => prisma.user.create({ data: { username: `${name}${tag}${++n}`, name, passwordHash: "x", role: "OPERATOR", employeeId: e.id, divisionId: divId } });
    const rico = await emp(); const bagus = await emp();
    const ur = await user(rico, "rico"); const ub = await user(bagus, "bagus");
    await absen(rico.id, D3, s1, "08:25");
    const wrong = await report(D3, s2, ur.username, "TERKIRIM");
    // hari lain: bentrok (laporan S1 sudah ada)
    await absen(rico.id, D4, s1, "08:25");
    const wrong2 = await report(D4, s2, ur.username, "TERKIRIM");
    await report(D4, s1, ub.username);
    const found = (await findReportShiftMismatches(4000, at(D4, "20:00"))).filter((f) => [wrong.id, wrong2.id].includes(f.id));
    expect(found.map((f) => [f.id, f.conflictWith === null])).toEqual([[wrong.id, true], [wrong2.id, false]]);
    expect(await applyReportShiftFixes(found)).toBe(1);
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: wrong.id } })).shiftId).toBe(s1);
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: wrong2.id } })).shiftId).toBe(s2);
  });
});

import { expectedSlots } from "@/lib/reportExpected";
import { deleteEmptyExtraDrafts, findExtraDrafts } from "@/lib/reportShift";
describe("Laporan diharapkan hanya untuk shift yang ada karyawannya", () => {
  it("divisi 2 shift berisi 1 orang → 1 laporan diharapkan; draf kosong shift lain dihapus, draf berisi hanya dilaporkan", async () => {
    const D5 = "2035-04-10";
    const div = await prisma.division.create({ data: { code: `OV${tag}`, name: `Oven Satu ${tag}`, shiftCount: 2, reportTemplate: "PRODUKSI" } });
    const e = await prisma.employee.create({ data: { code: `OV-${tag}`, name: `Marcello ${tag}`, divisionId: div.id, joinDate: dateOnly("2034-01-01") } });
    await prisma.shiftSchedule.create({ data: { employeeId: e.id, date: dateOnly(D5), shiftId: s2 } });
    await absen(e.id, D5, s2, "15:58");
    const mine = (await expectedSlots(D5, div.id));
    expect(mine.map((x) => [x.shift, x.sent])).toEqual([["Shift 2", false]]);
    // draf kosong Shift 1 (tanpa orang) + draf Shift 1 hari lain yang berisi data
    const empty = await prisma.shiftReport.create({ data: { date: dateOnly(D5), shiftId: s1, divisionId: div.id, picName: "x", status: "DRAFT", createdBy: "x", checklist: [{ label: "a", done: false }] } });
    const D6 = "2035-04-11";
    const filled = await prisma.shiftReport.create({ data: { date: dateOnly(D6), shiftId: s1, divisionId: div.id, picName: "x", status: "DRAFT", createdBy: "x", checklist: [{ label: "a", done: true }] } });
    const real = await prisma.shiftReport.create({ data: { date: dateOnly(D5), shiftId: s2, divisionId: div.id, picName: "marcello", status: "DRAFT", createdBy: "m" } });
    const extra = (await findExtraDrafts(4000, jakartaDateTime(D6, "20:00"))).filter((x) => [empty.id, filled.id, real.id].includes(x.id));
    expect(extra.map((x) => [x.id === empty.id ? "empty" : x.id === filled.id ? "filled" : "real", x.empty])).toEqual([["empty", true], ["filled", false]]);
    expect(await deleteEmptyExtraDrafts(extra, actor)).toBe(1);
    expect(await prisma.shiftReport.count({ where: { id: { in: [empty.id, filled.id, real.id] } } })).toBe(2);
    // Setelah laporan Shift 2 terkirim → 1/1 terkirim
    await prisma.shiftReport.update({ where: { id: real.id }, data: { status: "TERKIRIM" } });
    expect((await expectedSlots(D5, div.id)).map((x) => x.sent)).toEqual([true]);
  });
});
