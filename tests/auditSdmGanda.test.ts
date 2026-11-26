import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { approvePeriod, createPieceClaim, giveAdvance, generateMonthlyPayroll, PAYROLL_ACCRUAL_SOURCE } from "@/lib/payroll";
import { submitLeave } from "@/lib/leave";
import { submitDayOff, dayOffWindow } from "@/lib/dayOff";
import { selfCheckIn, selfCheckOut } from "@/lib/attendanceSelf";
import { dateOnly, jakartaDateTime, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
let actor: { id: string; name: string };
let bankId: string;
let divId: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  bankId = (await prisma.bankAccount.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } })).id;
  divId = (await prisma.division.findFirstOrThrow()).id;
});

async function emp(code: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.employee.create({ data: { code: `GDA-${code}-${tag}`, name: `Ganda ${code} ${tag}`, divisionId: divId, joinDate: dateOnly("2032-01-01"), ...extra } });
  const u = await prisma.user.create({ data: { username: `gda-${code.toLowerCase()}-${tag.toLowerCase()}`, name: e.name, role: "OPERATOR", passwordHash: "x", employeeId: e.id } });
  return { e, user: { id: u.id, name: u.name, role: u.role, employeeId: e.id } };
}
const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps);
const ok = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;

describe("Audit SDM: double input", () => {
  it("izin/sakit: dua pengajuan bersamaan hanya satu yang jadi", async () => {
    const { e, user } = await emp("L1");
    const now = jakartaDateTime("2032-05-10", "09:00");
    const input = { kind: "IZIN" as const, from: "2032-05-11", to: "2032-05-12", reason: "Urusan keluarga", hasAttachment: false };
    const rs = await settle([submitLeave(user, input, now), submitLeave(user, input, now), submitLeave(user, input, now)]);
    expect(ok(rs)).toBe(1);
    expect(await prisma.leaveRequest.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it("libur minggu depan: dua pengajuan bersamaan hanya satu yang jadi", async () => {
    const { e, user } = await emp("D1");
    const now = jakartaDateTime("2032-05-10", "09:00"); // Senin
    const w = dayOffWindow(todayStr(now));
    const input = { dates: [w.weekStart], reason: "Acara" };
    const rs = await settle([submitDayOff(user, input, now), submitDayOff(user, input, now)]);
    expect(ok(rs)).toBe(1);
    expect(await prisma.dayOffRequest.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it("kasbon: klik ganda (berurutan & bersamaan) hanya membukukan satu kasbon + satu jurnal", async () => {
    const { e } = await emp("K1", { wageType: "HARIAN", dailyRate: BigInt(100000) });
    const input = { employeeId: e.id, amount: 500000, installment: 100000, bankAccountId: bankId, date: "2032-05-10" };
    const rs = await settle([giveAdvance(input, actor), giveAdvance(input, actor)]);
    expect(ok(rs)).toBe(1);
    await expect(giveAdvance(input, actor)).rejects.toThrow(/baru saja/);
    const rows = await prisma.cashAdvance.findMany({ where: { employeeId: e.id } });
    expect(rows).toHaveLength(1);
    expect(await prisma.journal.count({ where: { source: "KASBON", sourceId: rows[0].number } })).toBe(1);
  });

  it("setujui periode gaji bersamaan: jurnal hutang gaji hanya satu", async () => {
    const { e } = await emp("P1", { wageType: "HARIAN", dailyRate: BigInt(100000) });
    const p = await prisma.payrollPeriod.create({ data: { code: `GDA-P-${tag}`, startDate: dateOnly("2032-05-01"), endDate: dateOnly("2032-05-07") } });
    await prisma.payslip.create({ data: { periodId: p.id, employeeId: e.id, daysPresent: 3, dailyWage: BigInt(300000), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), total: BigInt(300000) } });
    const rs = await settle([approvePeriod(p.id, actor), approvePeriod(p.id, actor)]);
    expect(ok(rs)).toBe(1);
    expect(await prisma.journal.count({ where: { source: PAYROLL_ACCRUAL_SOURCE, sourceId: p.id } })).toBe(1);
  });

  it("klaim borongan: klik ganda tidak membuat klaim kosong kedua", async () => {
    const { e } = await emp("B1", { wageType: "BORONGAN" });
    const task = await prisma.pieceTask.create({ data: { code: `GDA-T-${tag}`, name: `Tugas ${tag}`, ratePerPcs: BigInt(1000) } });
    await prisma.pieceWork.create({ data: { employeeId: e.id, taskId: task.id, date: dateOnly("2032-05-05"), qty: 10, rate: BigInt(1000), amount: BigInt(10000), createdBy: "t" } });
    const rs = await settle([createPieceClaim(e.id, "2032-05-10", actor), createPieceClaim(e.id, "2032-05-10", actor)]);
    expect(ok(rs)).toBe(1);
    expect(await prisma.payrollPeriod.count({ where: { employeeId: e.id, kind: "BORONGAN" } })).toBe(1);
  });

  it("slip gaji bulanan otomatis: scheduler + tombol bersamaan hanya membuat satu periode per siklus", async () => {
    await emp("M1", { wageType: "BULANAN", monthlySalary: BigInt(3000000), joinDate: dateOnly("2031-03-10") });
    const now = jakartaDateTime("2031-06-10", "08:00"); // siklus 10 Mei – 9 Jun
    const rs = await settle([generateMonthlyPayroll(actor, now), generateMonthlyPayroll(actor, now), generateMonthlyPayroll(actor, now)]);
    expect(ok(rs)).toBe(3);
    expect(await prisma.payrollPeriod.count({ where: { kind: "BULANAN", startDate: dateOnly("2031-05-10"), endDate: dateOnly("2031-06-09") } })).toBe(1);
  });
});

describe("Audit SDM: absen ganda", () => {
  it("absen masuk 2x bersamaan: satu baris, pesan ramah (bukan 'duplikat' mentah)", async () => {
    const { e, user } = await emp("A1");
    await prisma.shift.findFirstOrThrow({ where: { active: true } });
    const rs = await settle([selfCheckIn(user, null), selfCheckIn(user, null)]);
    expect(ok(rs)).toBe(1);
    const bad = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(bad.reason?.message ?? bad.reason)).toMatch(/sudah absen masuk/);
    expect(await prisma.attendance.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it("absen pulang 2x bersamaan: hanya satu yang tercatat", async () => {
    const { e, user } = await emp("A2");
    await selfCheckIn(user, null);
    const rs = await settle([selfCheckOut(user, null), selfCheckOut(user, null)]);
    expect(ok(rs)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "ABSEN_PULANG", entityId: (await prisma.attendance.findFirstOrThrow({ where: { employeeId: e.id } })).id } })).toBe(1);
  });
});

describe("Audit SDM: karyawan ganda", () => {
  it("simpan karyawan baru 2x bersamaan: hanya satu baris", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), assertPerm: async () => ({ id: actor.id, name: actor.name, role: "OWNER", can: () => true }) }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
    const { saveEmployee } = await import("@/app/(app)/karyawan/actions");
    const mk = () => {
      const fd = new FormData();
      fd.set("name", `Dobel Klik ${tag}`); fd.set("divisionId", divId); fd.set("status", "AKTIF"); fd.set("wageType", "HARIAN"); fd.set("dailyRate", "100000");
      return fd;
    };
    const rs = await Promise.all([saveEmployee(null, mk()), saveEmployee(null, mk())]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)?.error).toMatch(/sudah ada/);
    expect(await prisma.employee.count({ where: { name: `Dobel Klik ${tag}` } })).toBe(1);
  });
});
