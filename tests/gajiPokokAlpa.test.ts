import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { alpaDeduction, alpaInfo, allowanceCode, allowancePayDate, calcMonthly, generateAllowancePayroll } from "@/lib/payroll";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Potongan Alpa gaji bulanan (gaji pokok ÷ 30 × hari Alpa)", () => {
  it("0, 1, beberapa hari, pembulatan rupiah, batas gaji pokok", () => {
    expect(alpaDeduction(3_000_000, 0)).toBe(0);
    expect(alpaDeduction(3_000_000, 1)).toBe(100_000);
    expect(alpaDeduction(3_000_000, 4)).toBe(400_000);
    expect(alpaDeduction(2_500_000, 1)).toBe(83_333); // 83.333,33 → dibulatkan
    expect(alpaDeduction(2_600_000, 2)).toBe(173_333);
    expect(alpaDeduction(3_000_000, 31)).toBe(3_000_000); // tidak melebihi gaji pokok
    expect(alpaDeduction(0, 3)).toBe(0);
  });
  it("slip bulanan: total = pokok − Alpa − terlambat + transport; terlambat tidak membuat total di bawah 0", () => {
    const r = calcMonthly({ monthlySalary: 3_000_000, alpaDays: 2, lateMinutes: 30, lateDeductionPerMinute: 1000, transport: 50_000, resignedBeforePayday: false });
    expect([r.alpaDeduction, r.deduction, r.total]).toEqual([200_000, 30_000, 2_820_000]);
    expect(r.note).toContain("Potongan Alpa 2 hari");
    const all = calcMonthly({ monthlySalary: 3_000_000, alpaDays: 30, lateMinutes: 999, lateDeductionPerMinute: 1000, transport: 0, resignedBeforePayday: false });
    expect([all.alpaDeduction, all.deduction, all.total]).toEqual([3_000_000, 0, 0]);
    expect(alpaInfo([])).toBeNull(); // slip lama (aturan bolos)
    expect(alpaInfo({ rule: "alpa30", from: "2026-10-10", dates: [] })?.dates).toEqual([]);
  });
});

describe("Tanggal bayar tunjangan per orang", () => {
  it("29/30/31 di Februari → akhir bulan; kode periode", () => {
    expect(allowancePayDate("2027-02", 29)).toBe("2027-02-28");
    expect(allowancePayDate("2027-02", 30)).toBe("2027-02-28");
    expect(allowancePayDate("2027-02", 31)).toBe("2027-02-28");
    expect(allowancePayDate("2028-02", 31)).toBe("2028-02-29"); // kabisat
    expect(allowancePayDate("2027-04", 31)).toBe("2027-04-30");
    expect(allowancePayDate("2027-01", 5)).toBe("2027-01-05");
    expect(allowanceCode("2027-02-15")).toBe("TNJ-202702"); // data lama tgl 15 tetap
    expect(allowanceCode("2027-02-28")).toBe("TNJ-202702-28");
  });

  it("periode per tanggal bayar, tidak dobel di bulan yang sama (walau tanggal bayar diubah)", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const tag = Date.now().toString(36).slice(-4).toUpperCase();
    const mk = (n: string) => prisma.employee.create({ data: { code: `TNJ-${n}-${tag}`, name: `Tunjangan ${n} ${tag}`, divisionId: div.id, joinDate: dateOnly("2033-01-01") } });
    const x = await mk("X");
    const y = await mk("Y");
    await prisma.employeeAllowance.create({ data: { employeeId: x.id, name: "Tunjangan makan", amount: BigInt(300_000) } }); // bawaan tgl 15
    const ya = await prisma.employeeAllowance.create({ data: { employeeId: y.id, name: "Tunjangan jabatan", amount: BigInt(500_000), payDay: 31 } });
    expect((await generateAllowancePayroll(actor, jakartaDateTime("2034-02-14", "09:00"))).created).toBeNull();
    expect((await generateAllowancePayroll(actor, jakartaDateTime("2034-02-15", "09:00"))).created).toBe("TNJ-203402");
    const p15 = await prisma.payrollPeriod.findUniqueOrThrow({ where: { code: "TNJ-203402" }, include: { payslips: true } });
    expect(p15.payslips.map((s) => [s.employeeId, Number(s.total)])).toContainEqual([x.id, 300_000]);
    expect(p15.payslips.some((s) => s.employeeId === y.id)).toBe(false);
    // Tanggal bayar Y diubah ke 15 setelah periode tgl 15 dibuat, lalu kembali 31: tetap hanya sekali bulan ini
    await prisma.employeeAllowance.update({ where: { id: ya.id }, data: { payDay: 28 } });
    expect((await generateAllowancePayroll(actor, jakartaDateTime("2034-02-28", "09:00"))).created).toBe("TNJ-203402-28");
    const p28 = await prisma.payrollPeriod.findUniqueOrThrow({ where: { code: "TNJ-203402-28" }, include: { payslips: true } });
    expect(p28.payslips.map((s) => s.employeeId)).toEqual([y.id]);
    // Ulang di hari yang sama: tidak dobel
    expect((await generateAllowancePayroll(actor, jakartaDateTime("2034-02-28", "10:00"))).created).toBeNull();
    // X dipindah ke tgl 28 setelah sudah dibayar tgl 15: tidak ditagih lagi bulan ini (periode tgl 28 dihitung ulang)
    const xa = await prisma.employeeAllowance.findFirstOrThrow({ where: { employeeId: x.id } });
    await prisma.employeeAllowance.update({ where: { id: xa.id }, data: { payDay: 28 } });
    const { computePeriod } = await import("@/lib/payroll");
    await computePeriod(p28.id, actor);
    expect((await prisma.payslip.findMany({ where: { periodId: p28.id } })).map((s) => s.employeeId)).toEqual([y.id]);
    // Nonaktif: tidak dibayar bulan berikutnya
    await prisma.employeeAllowance.update({ where: { id: ya.id }, data: { active: false } });
    await generateAllowancePayroll(actor, jakartaDateTime("2034-03-31", "09:00"));
    expect(await prisma.payslip.count({ where: { employeeId: y.id, period: { code: { startsWith: "TNJ-203403" } } } })).toBe(0);
  });
});
