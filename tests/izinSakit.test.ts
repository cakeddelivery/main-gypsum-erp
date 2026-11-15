import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { canDecideLeave, cancelLeave, decideLeave, leaveAttendanceStatus, leaveDays, leaveError, submitLeave } from "@/lib/leave";
import { AUTO_NOTE, markMissingAttendance } from "@/lib/attendanceAuto";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const base = { kind: "IZIN" as const, reason: "Urusan keluarga", hasAttachment: false };

describe("Izin & Sakit: aturan isian (murni)", () => {
  it("rentang, tanggal mundur, alasan, dan surat dokter untuk sakit > 1 hari", () => {
    const today = "2032-05-10";
    expect(leaveError({ ...base, from: "2032-05-10", to: "2032-05-10" }, today)).toBeNull();
    expect(leaveError({ ...base, from: "2032-05-12", to: "2032-05-11" }, today)).toMatch(/sebelum/);
    expect(leaveError({ ...base, from: "2032-05-01", to: "2032-05-01" }, today)).toMatch(/7 hari/);
    expect(leaveError({ ...base, from: "2032-05-10", to: "2032-05-30" }, today)).toMatch(/14 hari/);
    expect(leaveError({ ...base, reason: " ", from: "2032-05-10", to: "2032-05-10" }, today)).toMatch(/Alasan/);
    expect(leaveError({ ...base, kind: "SAKIT", from: "2032-05-10", to: "2032-05-10" }, today)).toBeNull();
    expect(leaveError({ ...base, kind: "SAKIT", from: "2032-05-10", to: "2032-05-11" }, today)).toMatch(/surat dokter/);
    expect(leaveError({ ...base, kind: "SAKIT", from: "2032-05-10", to: "2032-05-11", hasAttachment: true }, today)).toBeNull();
    expect(leaveDays("2032-05-30", "2032-06-02")).toEqual(["2032-05-30", "2032-05-31", "2032-06-01", "2032-06-02"]);
  });

  it("Alpa diganti; hadir/terlambat/libur/sudah absen dibiarkan", () => {
    expect(leaveAttendanceStatus("SAKIT", null)).toBe("SAKIT");
    expect(leaveAttendanceStatus("IZIN", { status: "ALPA", checkIn: null })).toBe("IZIN");
    expect(leaveAttendanceStatus("IZIN", { status: "HADIR", checkIn: new Date() })).toBeNull();
    expect(leaveAttendanceStatus("IZIN", { status: "TERLAMBAT", checkIn: new Date() })).toBeNull();
    expect(leaveAttendanceStatus("IZIN", { status: "LIBUR", checkIn: null })).toBeNull();
  });

  it("yang boleh menyetujui hanya Supervisor atau Owner", () => {
    expect(canDecideLeave("SUPERVISOR")).toBe(true);
    expect(canDecideLeave("OWNER")).toBe(true);
    for (const r of ["FINANCE", "ADMIN", "ADMIN_PRODUKSI", "KAPTEN_DIVISI", "OPERATOR"] as const) expect(canDecideLeave(r)).toBe(false);
  });
});

describe("Izin & Sakit: alur dengan database", () => {
  async function setup(code: string) {
    const div = await prisma.division.findFirstOrThrow();
    const emp = await prisma.employee.create({ data: { code: `IZN-${code}-${tag}`, name: `Izin ${code} ${tag}`, divisionId: div.id, joinDate: dateOnly("2032-01-01") } });
    const u = await prisma.user.create({ data: { username: `izn-${code.toLowerCase()}-${tag.toLowerCase()}`, name: emp.name, role: "OPERATOR", passwordHash: "x", employeeId: emp.id } });
    return { emp, actor: { id: u.id, name: u.name, role: u.role, employeeId: emp.id } };
  }
  const now = jakartaDateTime("2032-05-10", "09:00");

  it("disetujui Supervisor → hari Alpa otomatis jadi Izin, hari hadir tetap; tidak dobel saat job Alpa jalan lagi", async () => {
    const { emp, actor } = await setup("A");
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true } });
    // 07 & 08 belum ada catatan → job 06.00 tanggal 10 memberi Alpa 07–09; tgl 09 sebenarnya hadir
    await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly("2032-05-09"), status: "HADIR", checkIn: jakartaDateTime("2032-05-09", "08:00") } });
    await markMissingAttendance(jakartaDateTime("2032-05-10", "06:00"));
    const alpa = await prisma.attendance.findMany({ where: { employeeId: emp.id, status: "ALPA" } });
    expect(alpa.map((a) => a.note)).toEqual([AUTO_NOTE, AUTO_NOTE]);

    const req = await submitLeave(actor, { ...base, from: "2032-05-07", to: "2032-05-11" }, now);
    expect(req.status).toBe("MENUNGGU");
    // Pengajuan bertumpuk ditolak
    await expect(submitLeave(actor, { ...base, from: "2032-05-11", to: "2032-05-11" }, now)).rejects.toThrow(/Sudah ada pengajuan/);

    const spv = await prisma.user.create({ data: { username: `izn-spv-${tag.toLowerCase()}`, name: "SPV Izin", role: "SUPERVISOR", passwordHash: "x" } });
    const r = await decideLeave({ id: spv.id, name: spv.name, role: spv.role, employeeId: null }, req.id, true);
    expect(r).toEqual({ applied: 4, skipped: 1 });
    const rows = await prisma.attendance.findMany({ where: { employeeId: emp.id }, orderBy: { date: "asc" } });
    expect(rows.map((a) => `${a.date.toISOString().slice(0, 10)} ${a.status}`)).toEqual(["2032-05-07 IZIN", "2032-05-08 IZIN", "2032-05-09 HADIR", "2032-05-10 IZIN", "2032-05-11 IZIN"]);
    expect(rows.filter((a) => a.status === "IZIN").every((a) => a.validated && a.note?.startsWith("Pengajuan disetujui"))).toBe(true);
    // Job Alpa jalan lagi (besok) → tidak menambah apa pun untuk hari yang sudah Izin
    await markMissingAttendance(jakartaDateTime("2032-05-12", "06:00"));
    expect(await prisma.attendance.count({ where: { employeeId: emp.id } })).toBe(5);
    expect(await prisma.attendance.count({ where: { employeeId: emp.id, status: "ALPA" } })).toBe(0);
    // Sudah diputuskan → Owner tidak bisa memutuskan lagi
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await expect(decideLeave({ id: owner.id, name: owner.name, role: owner.role, employeeId: null }, req.id, false, "x")).rejects.toThrow(/sudah diputuskan/);
  });

  it("Owner menolak (wajib alasan) → absensi tidak berubah; role lain tidak boleh memutuskan; batal hanya saat menunggu", async () => {
    const { emp, actor } = await setup("B");
    const req = await submitLeave(actor, { ...base, kind: "SAKIT", from: "2032-05-10", to: "2032-05-10" }, now);
    const fin = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
    const kap = await prisma.user.findUniqueOrThrow({ where: { username: "kapten" } });
    await expect(decideLeave({ id: fin.id, name: fin.name, role: fin.role, employeeId: null }, req.id, true)).rejects.toThrow(/Supervisor atau Owner/);
    await expect(decideLeave({ id: kap.id, name: kap.name, role: kap.role, employeeId: kap.employeeId }, req.id, true)).rejects.toThrow(/Supervisor atau Owner/);
    await expect(decideLeave(actor, req.id, true)).rejects.toThrow(/Supervisor atau Owner/);
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const o = { id: owner.id, name: owner.name, role: owner.role, employeeId: null };
    await expect(decideLeave(o, req.id, false, " ")).rejects.toThrow(/alasan penolakan/);
    await decideLeave(o, req.id, false, "Tidak ada surat");
    const after = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect([after.status, after.rejectReason, after.decidedBy]).toEqual(["DITOLAK", "Tidak ada surat", owner.name]);
    expect(await prisma.attendance.count({ where: { employeeId: emp.id } })).toBe(0);
    await expect(cancelLeave(actor, req.id)).rejects.toThrow(/sudah diputuskan/);
    // Ditolak → boleh mengajukan ulang tanggal yang sama, lalu dibatalkan sendiri
    const again = await submitLeave(actor, { ...base, from: "2032-05-10", to: "2032-05-10" }, now);
    await cancelLeave(actor, again.id);
    expect(await prisma.leaveRequest.findUnique({ where: { id: again.id } })).toBeNull();
    // Sakit 2 hari tanpa surat dokter ditolak sistem
    await expect(submitLeave(actor, { ...base, kind: "SAKIT", from: "2032-05-10", to: "2032-05-11" }, now)).rejects.toThrow(/surat dokter/);
  });
});
