import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { employeeMonthlyCost, salaryBreakdown, syncSalaryOverheads } from "@/lib/salaryOverhead";
import { overheadUnitCost } from "@/lib/hpp";

describe("Overhead Gaji Produksi otomatis", () => {
  it("biaya bulanan per karyawan = gaji pokok + tunjangan aktif + BPJS TK; borongan 0", () => {
    const base = { bpjsTk: true, bpjsTkAmount: null, allowances: [{ name: "Makan", amount: 200000n, active: true }, { name: "Lama", amount: 50000n, active: false }] };
    expect(employeeMonthlyCost({ ...base, wageType: "BULANAN", monthlySalary: 2000000n, dailyRate: 0n }, { workdays: 26, bpjsDefault: 28400 })).toEqual({ base: 2000000, allowance: 200000, bpjs: 28400, total: 2228400 });
    expect(employeeMonthlyCost({ ...base, wageType: "HARIAN", monthlySalary: 0n, dailyRate: 80000n, bpjsTk: false }, { workdays: 26, bpjsDefault: 28400 }).total).toBe(80000 * 26 + 200000);
    expect(employeeMonthlyCost({ ...base, wageType: "BORONGAN", monthlySalary: 0n, dailyRate: 0n, allowances: [], bpjsTk: false }, { workdays: 26, bpjsDefault: 28400 }).total).toBe(0);
  });

  let divId: string;
  let empId: string;
  beforeAll(async () => {
    const d = await prisma.division.create({ data: { code: "UJIGJ", name: "Divisi Uji Gaji", reportTemplate: null } });
    divId = d.id;
    const e = await prisma.employee.create({ data: { code: "UJIGJ-001", name: "Uji Satu", divisionId: d.id, wageType: "BULANAN", monthlySalary: 2000000n, bpjsTk: true, bpjsTkAmount: 30000n, allowances: { create: [{ name: "Makan", amount: 150000n }] } } });
    empId = e.id;
    await prisma.employee.create({ data: { code: "UJIGJ-002", name: "Uji Borongan", divisionId: d.id, wageType: "BORONGAN" } });
    await prisma.employee.create({ data: { code: "UJIGJ-003", name: "Uji Resign", divisionId: d.id, wageType: "BULANAN", monthlySalary: 1000000n, status: "NONAKTIF" } });
  });

  it("total divisi hanya karyawan aktif non-borongan; overhead ikut naik saat gaji naik", async () => {
    const b = await salaryBreakdown([divId]);
    expect(b.rows.map((r) => r.name)).toEqual(["Uji Satu"]);
    expect(b.total).toBe(2000000 + 150000 + 30000);
    const o = await prisma.overhead.create({ data: { category: "Gaji Produksi", name: "Gaji Produksi", monthlyAmount: 0n, outputPerMonth: 1000, autoSalary: true, salaryDivisionIds: [divId] } });
    await syncSalaryOverheads();
    expect(Number((await prisma.overhead.findUniqueOrThrow({ where: { id: o.id } })).monthlyAmount)).toBe(2180000);
    // Gaji naik + tunjangan baru → overhead ikut berubah
    await prisma.employee.update({ where: { id: empId }, data: { monthlySalary: 2500000n } });
    await prisma.employeeAllowance.create({ data: { employeeId: empId, name: "Transport", amount: 100000n } });
    const changed = await syncSalaryOverheads();
    expect(changed).toEqual([{ id: o.id, name: "Gaji Produksi", from: 2180000, to: 2780000 }]);
    const fresh = await prisma.overhead.findUniqueOrThrow({ where: { id: o.id } });
    expect(overheadUnitCost(fresh)).toBe(2780);
    // Tidak membuat jurnal apa pun
    expect(await prisma.journal.count({ where: { description: { contains: "Gaji Produksi" } } })).toBe(0);
    await prisma.overhead.update({ where: { id: o.id }, data: { active: false, autoSalary: false } });
  });
});
