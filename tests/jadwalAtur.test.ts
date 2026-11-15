import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { allIn, cellKey, cellOf, diffCells, parseChanges, quickFill, type Cell } from "@/lib/scheduleEdit";
import { applyScheduleChanges } from "@/lib/scheduleSave";
import { LIBUR_NOTE, markMissingAttendance } from "@/lib/attendanceAuto";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const D = "2033-02-07";
const rows = [
  { employeeId: "a", shiftDiv: false },
  { employeeId: "b", shiftDiv: false },
  { employeeId: "c", shiftDiv: true },
  { employeeId: "d", shiftDiv: true },
];

describe("Jadwal: tombol cepat per tanggal", () => {
  it("Semua masuk: centang divisi 1 shift; divisi 2 shift yang sudah S2 dibiarkan, yang kosong jadi S1", () => {
    const start: Record<string, Cell> = { [cellKey("d", D)]: "S2", [cellKey("a", "2033-02-08")]: "IN" };
    const next = quickFill(start, D, rows);
    expect([next[cellKey("a", D)], next[cellKey("b", D)], next[cellKey("c", D)], next[cellKey("d", D)]]).toEqual(["IN", "IN", "S1", "S2"]);
    expect(next[cellKey("a", "2033-02-08")]).toBe("IN"); // tanggal lain tidak tersentuh
    expect(allIn(next, D, rows)).toBe(true);
    // Ditekan lagi saat semua sudah masuk → Kosongkan tanggal itu
    const cleared = quickFill(next, D, rows);
    expect(rows.map((r) => cleared[cellKey(r.employeeId, D)])).toEqual(["", "", "", ""]);
    expect(cleared[cellKey("a", "2033-02-08")]).toBe("IN");
  });

  it("perubahan dihitung dari selisih draf vs tersimpan; nilai sel dari shift tersimpan", () => {
    const saved: Record<string, Cell> = { [cellKey("a", D)]: "IN", [cellKey("c", D)]: "S1" };
    const draft: Record<string, Cell> = { ...saved, [cellKey("a", D)]: "", [cellKey("c", D)]: "S2", [cellKey("b", D)]: "IN" };
    expect(diffCells(saved, draft)).toEqual([
      { employeeId: "a", date: D, value: "" },
      { employeeId: "b", date: D, value: "IN" },
      { employeeId: "c", date: D, value: "S2" },
    ]);
    expect(diffCells(saved, { ...saved })).toEqual([]);
    expect([cellOf(null, false), cellOf(0, false), cellOf(1, false), cellOf(0, true), cellOf(1, true)]).toEqual(["", "IN", "IN", "S1", "S2"]);
    expect(() => parseChanges([{ employeeId: "a", date: "07-02-2033", value: "IN" }])).toThrow();
    expect(() => parseChanges([{ employeeId: "a", date: D, value: "S9" }])).toThrow();
    expect(() => parseChanges("x")).toThrow();
  });
});

describe("Jadwal: simpan sekaligus & Libur sesuai jadwal", () => {
  it("IN/S1/S2/hapus tersimpan dalam satu kali simpan; hari tak dicentang di minggu terjadwal jadi Libur, minggu belum diatur tetap Alpa", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const tag = Date.now().toString(36).slice(-5).toUpperCase();
    const mk = (n: string) => prisma.employee.create({ data: { code: `JDW-${n}-${tag}`, name: `Jadwal ${n} ${tag}`, divisionId: div.id, joinDate: dateOnly("2033-01-01") } });
    const a = await mk("A");
    const c = await mk("C");
    const z = await mk("Z");
    const [s1, s2] = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
    // Senin 7 Feb: A masuk, C shift 2; Selasa 8 Feb: C shift 1 lalu dihapus (libur)
    await applyScheduleChanges(parseChanges([
      { employeeId: a.id, date: "2033-02-07", value: "IN" },
      { employeeId: c.id, date: "2033-02-07", value: "S2" },
      { employeeId: c.id, date: "2033-02-08", value: "S1" },
    ]));
    // IN pada jadwal yang sudah ada mempertahankan shift lamanya
    await prisma.shiftSchedule.update({ where: { employeeId_date: { employeeId: a.id, date: dateOnly("2033-02-07") } }, data: { shiftId: s2.id } });
    const r = await applyScheduleChanges(parseChanges([
      { employeeId: a.id, date: "2033-02-07", value: "IN" },
      { employeeId: c.id, date: "2033-02-08", value: "" },
    ]));
    expect(r).toEqual({ saved: 1, removed: 1 });
    const sch = await prisma.shiftSchedule.findMany({ where: { employeeId: { in: [a.id, c.id] } }, orderBy: [{ employeeId: "asc" }, { date: "asc" }] });
    expect(sch.map((s) => [s.employeeId === a.id ? "A" : "C", s.date.toISOString().slice(0, 10), s.shiftId === s1.id ? "S1" : "S2"]).sort()).toEqual([["A", "2033-02-07", "S2"], ["C", "2033-02-07", "S2"]]);

    // Job 06.00 Rabu 9 Feb mengisi Senin–Selasa (dan Minggu sebelumnya) yang belum ada absen
    await markMissingAttendance(jakartaDateTime("2033-02-09", "06:00"));
    const att = await prisma.attendance.findMany({ where: { employeeId: { in: [a.id, c.id, z.id] }, date: dateOnly("2033-02-08") } });
    const st = (id: string) => att.find((x) => x.employeeId === id);
    expect(st(c.id)?.status).toBe("LIBUR"); // minggu terjadwal, Selasa tidak dicentang
    expect(st(c.id)?.note).toBe(LIBUR_NOTE);
    expect(st(a.id)?.status).toBe("LIBUR");
    expect(st(z.id)?.status).toBe("ALPA"); // tidak ada jadwal sama sekali minggu itu
    const mon = await prisma.attendance.findMany({ where: { employeeId: { in: [a.id, c.id] }, date: dateOnly("2033-02-07") } });
    expect(mon.map((x) => x.status)).toEqual(["ALPA", "ALPA"]); // dijadwalkan masuk tapi tidak absen = Alpa
  });
});
