import { describe, expect, it } from "vitest";
import { calcMonthly, countAbsence, lastCompletedCycle } from "@/lib/payroll";
import { splitPayment } from "@/lib/purchase";
import { reserveLines } from "@/lib/reserve";
import { validateLines } from "@/lib/accounting";
import { growth } from "@/lib/analytics";
import { addDays } from "@/lib/time";

describe("Siklus gaji bulanan H+7", () => {
  it("masuk tgl 10: siklus 10 Okt – 9 Nov, gajian 17 Nov", () => {
    expect(lastCompletedCycle("2026-01-10", "2026-11-10")).toEqual({ start: "2026-10-10", end: "2026-11-09", anniversary: "2026-11-10", payDate: "2026-11-17" });
    // sebelum ulang bulan berikutnya, siklus terakhir tetap yang sama
    expect(lastCompletedCycle("2026-01-10", "2026-12-09")?.anniversary).toBe("2026-11-10");
  });
  it("belum genap sebulan = belum ada siklus", () => {
    expect(lastCompletedCycle("2026-10-20", "2026-11-05")).toBeNull();
    expect(lastCompletedCycle("2026-10-20", "2026-11-20")?.start).toBe("2026-10-20");
  });
  it("masuk tgl 31 mengikuti akhir bulan", () => {
    expect(lastCompletedCycle("2026-01-31", "2026-03-01")).toMatchObject({ start: "2026-01-31", end: "2026-02-27", anniversary: "2026-02-28" });
  });
});

describe("Jatah libur 1x per minggu", () => {
  const days = (start: string, n: number, skip: number[] = []) => new Set(Array.from({ length: n }, (_, i) => i).filter((i) => !skip.includes(i)).map((i) => addDays(start, i)));
  it("1 libur per minggu tidak dihitung bolos", () => {
    const r = countAbsence("2026-10-10", "2026-11-09", days("2026-10-10", 31, [6, 13, 20, 27]));
    expect(r).toMatchObject({ offDays: 4, absentDays: 0 });
  });
  it("2 hari tidak masuk dalam seminggu = 1 bolos", () => {
    const r = countAbsence("2026-10-10", "2026-10-16", days("2026-10-10", 7, [2, 3]));
    expect(r).toMatchObject({ offDays: 1, absentDays: 1 });
  });
});

describe("Gaji bulanan", () => {
  it("potong bolos per hari dari gaji ÷ 26", () => {
    const r = calcMonthly({ monthlySalary: 2_600_000, absentDays: 2, workdaysPerMonth: 26, lateMinutes: 0, lateDeductionPerMinute: 0, transport: 0, resignedBeforePayday: false });
    expect(r.total).toBe(2_400_000);
  });
  it("resign sebelum gajian = Rp0", () => {
    expect(calcMonthly({ monthlySalary: 2_600_000, absentDays: 0, workdaysPerMonth: 26, lateMinutes: 0, lateDeductionPerMinute: 0, transport: 50_000, resignedBeforePayday: true }).total).toBe(0);
  });
});

describe("Pembelian & sisihan", () => {
  it("cara bayar lunas / bertahap / tempo", () => {
    expect(splitPayment("LUNAS", 1000, 0)).toEqual({ paid: 1000, debt: 0 });
    expect(splitPayment("BERTAHAP", 1000, 300)).toEqual({ paid: 300, debt: 700 });
    expect(splitPayment("TEMPO", 1000, 0)).toEqual({ paid: 0, debt: 1000 });
    expect(() => splitPayment("BERTAHAP", 1000, 1000)).toThrow();
  });
  it("jurnal sisihan seimbang", () => {
    expect(validateLines(reserveLines("OWNER", 100_000, "a", "b"))).toBe(200_000);
    expect(validateLines(reserveLines("LOAN_SAVING", 300_000, "a", "b"))).toBe(300_000);
  });
  it("growth %", () => {
    expect(growth(120, 100)).toBe(20);
    expect(growth(5, 0)).toBeNull();
  });
});
