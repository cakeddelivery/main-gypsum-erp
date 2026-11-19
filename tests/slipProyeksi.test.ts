import { describe, expect, it } from "vitest";
import { alpaCut, projectSalary, runningCycle } from "@/lib/salaryProjection";
import { alpaDeduction, lastCompletedCycle } from "@/lib/payroll";

describe("Proyeksi gaji & simulasi bolos", () => {
  it("siklus berjalan: dari tgl masuk, gajian H+7 setelah siklus berakhir", () => {
    expect(runningCycle("2026-10-10", "2026-11-19")).toEqual({ start: "2026-11-10", end: "2026-12-09", payDate: "2026-12-17", daysLeft: 21 });
    expect(runningCycle("2026-10-10", "2026-11-10").start).toBe("2026-11-10"); // hari ulang bulan = awal siklus baru
    expect(runningCycle("2026-10-10", "2026-11-09").start).toBe("2026-10-10");
    expect(runningCycle("2026-01-31", "2026-03-05")).toMatchObject({ start: "2026-02-28", end: "2026-03-30" }); // tgl 31 → akhir bulan pendek
  });
  it("siklus berjalan konsisten dengan siklus penggajian yang sudah selesai", () => {
    const done = lastCompletedCycle("2026-10-10", "2026-12-10")!; // siklus 10 Nov–9 Des selesai di 10 Des
    expect(runningCycle("2026-10-10", "2026-11-19")).toMatchObject({ start: done.start, end: done.end, payDate: done.payDate });
  });
  it("potongan Alpa = gaji pokok ÷ 30 × hari, sama dengan penggajian; tidak melebihi gaji pokok", () => {
    expect(alpaCut(1_000_000, 0)).toBe(0);
    expect(alpaCut(1_000_000, 3)).toBe(100_000);
    expect(alpaCut(1_000_000, 40)).toBe(1_000_000);
    for (const d of [0, 1, 2, 7, 31]) expect(alpaCut(1_500_000, d)).toBe(alpaDeduction(1_500_000, d));
  });
  it("simulasi: 0/1/2/3 hari ditambah Alpa yang sudah ada; tunjangan tidak dipotong", () => {
    const i = { baseSalary: 1_000_000, allowanceTotal: 150_000, alpaSoFar: 0 };
    expect(projectSalary(i).total).toBe(1_150_000);
    expect(projectSalary(i, 1)).toMatchObject({ cut: 33_333, total: 1_116_667, alpaDays: 1 });
    expect(projectSalary(i, 3).total).toBe(1_050_000);
    expect(projectSalary({ ...i, alpaSoFar: 2 }, 1)).toMatchObject({ alpaDays: 3, cut: 100_000 });
    expect(projectSalary(i, -5).alpaDays).toBe(0);
  });
});
