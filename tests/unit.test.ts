import { describe, expect, it } from "vitest";
import { parseIDR, idr } from "@/lib/money";
import { extractAmount, extractDate, extractTransaction, suggestCategory } from "@/lib/extract";
import { validateLines, monthlyDepreciation } from "@/lib/accounting";
import { evaluateCheckIn } from "@/lib/attendance";
import { calcPayslip } from "@/lib/payroll";
import { calcHpp, margin } from "@/lib/hpp";
import { effectivePermissions, DEFAULT_MATRIX } from "@/lib/rbac";
import { jakartaParts, monthRange, todayStr } from "@/lib/time";

describe("IDR", () => {
  it("parse format Indonesia", () => {
    expect(parseIDR("Rp 1.250.000")).toBe(1250000);
    expect(parseIDR("150rb")).toBe(150000);
    expect(parseIDR("1,5jt")).toBe(1500000);
    expect(parseIDR("2 juta".replace(" ", ""))).toBe(2000000);
    expect(parseIDR("abc")).toBeNull();
    expect(idr(1500000)).toBe("Rp 1.500.000");
  });
});

describe("Zona waktu Asia/Jakarta", () => {
  it("23.30 UTC = besok 06.30 WIB", () => {
    const p = jakartaParts(new Date("2026-10-27T23:30:00Z"));
    expect([p.day, p.hour, p.minute]).toEqual([28, 6, 30]);
    expect(todayStr(new Date("2026-10-27T23:30:00Z"))).toBe("2026-10-28");
  });
  it("rentang bulan WIB", () => {
    const r = monthRange(2026, 10);
    expect(r.start.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });
});

describe("Ekstraksi transaksi", () => {
  const accounts = [
    { id: "sea", code: "SEABANK", name: "Seabank", aliases: "seabank" },
    { id: "spay", code: "SHOPEEPAY", name: "ShopeePay", aliases: "shopeepay,spay" },
    { id: "sps", code: "SALDO_SHOPEE", name: "Saldo Penjual Shopee", aliases: "saldo penjual" },
  ];
  const cats = [
    { id: "listrik", name: "Listrik, Air & Gas", direction: "KELUAR" as const, keywords: "listrik,pln,token" },
    { id: "bahan", name: "Pembelian Bahan Baku", direction: "KELUAR" as const, keywords: "gypsum,cat" },
    { id: "jual", name: "Penjualan Produk", direction: "MASUK" as const, keywords: "penjualan,pencairan" },
  ];
  it("pengeluaran lengkap", () => {
    const e = extractTransaction("bayar listrik 350rb dari seabank 12/10/2026", accounts, cats);
    expect(e).toMatchObject({ amount: 350000, direction: "KELUAR", accountId: "sea", categoryId: "listrik", date: "2026-10-12", missing: [] });
  });
  it("transfer internal tanpa kategori", () => {
    const e = extractTransaction("transfer internal dari saldo penjual ke seabank 500.000", accounts, cats);
    expect(e).toMatchObject({ direction: "TRANSFER", accountId: "sps", toAccountId: "sea", categoryId: null, amount: 500000 });
  });
  it("data kurang ditandai", () => {
    const e = extractTransaction("beli sesuatu 20rb", accounts, cats);
    expect(e.missing).toContain("rekening");
  });
  it("tanggal & nominal", () => {
    expect(extractDate("5 Okt 2026")).toBe("2026-10-05");
    expect(extractAmount("Total: Rp 1.234.500")).toBe(1234500);
    expect(suggestCategory("beli gypsum 10 sak", "KELUAR", cats)).toBe("bahan");
  });
});

describe("Double-entry", () => {
  it("menolak jurnal tidak seimbang / ganda sisi / pecahan", () => {
    expect(() => validateLines([{ accountCode: "a", debit: 100 }, { accountCode: "b", credit: 90 }])).toThrow(/tidak seimbang/);
    expect(() => validateLines([{ accountCode: "a", debit: 100, credit: 100 }, { accountCode: "b", credit: 0 }])).toThrow();
    expect(() => validateLines([{ accountCode: "a", debit: 10.5 }, { accountCode: "b", credit: 10.5 }])).toThrow(/bulat/);
    expect(validateLines([{ accountCode: "a", debit: 100 }, { accountCode: "b", credit: 100 }])).toBe(100);
  });
  it("penyusutan garis lurus", () => {
    expect(monthlyDepreciation(12_000_000, 0, 24)).toBe(500000);
  });
});

describe("Absensi berbasis shift dengan toleransi", () => {
  const shift = { startTime: "07:00", toleranceMinutes: 10 };
  it("masih dalam toleransi = hadir", () => {
    expect(evaluateCheckIn(shift, new Date("2026-10-28T00:08:00Z"))).toEqual({ status: "HADIR", lateMinutes: 8 });
  });
  it("lewat toleransi = terlambat", () => {
    expect(evaluateCheckIn(shift, new Date("2026-10-28T00:25:00Z"))).toEqual({ status: "TERLAMBAT", lateMinutes: 25 });
  });
});

describe("Penggajian", () => {
  it("campuran: harian + borongan + transport - potongan", () => {
    const r = calcPayslip({ wageType: "CAMPURAN", dailyRate: 50000, daysPresent: 6, lateMinutes: 20, pieces: { ASSEMBLING: 1000, FILLING_CAT: 10 }, rates: { ASSEMBLING: 200 }, transport: 60000, lateDeductionPerMinute: 500 });
    expect(r).toMatchObject({ dailyWage: 300000, pieceWage: 200000, transport: 60000, deduction: 10000, total: 550000 });
  });
  it("borongan tidak dapat upah harian", () => {
    const r = calcPayslip({ wageType: "BORONGAN", dailyRate: 70000, daysPresent: 5, lateMinutes: 0, pieces: { FILLING_CAT: 500 }, rates: { FILLING_CAT: 150 }, transport: 0, lateDeductionPerMinute: 0 });
    expect(r.total).toBe(75000);
  });
});

describe("HPP & margin", () => {
  it("hpp = bahan + tenaga kerja + overhead", () => {
    expect(calcHpp(1000, 600, 250)).toBe(1850);
    expect(margin(5000, 1850)).toEqual({ value: 3150, pct: 63 });
  });
});

describe("RBAC", () => {
  it("owner punya semua, override bisa mencabut, menu bot khusus owner", () => {
    expect(effectivePermissions("OWNER", []).has("telegram.manage")).toBe(true);
    expect(effectivePermissions("ADMIN", [{ role: "ADMIN", permission: "telegram.manage", allowed: true }]).has("telegram.manage")).toBe(false);
    expect(effectivePermissions("FINANCE", [{ role: "FINANCE", permission: "finance.approve", allowed: false }]).has("finance.approve")).toBe(false);
    expect(DEFAULT_MATRIX.OPERATOR).not.toContain("finance.view");
  });
});
