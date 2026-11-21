import { describe, expect, it } from "vitest";
import { buckets, bucketKey, deltaPct, resolvePeriod } from "@/lib/marketplace/periode";

const T = "2026-11-21"; // Sabtu
describe("Periode laporan marketplace", () => {
  it("pilihan cepat & bawaan 'Bulan ini'", () => {
    expect(resolvePeriod({}, T)).toMatchObject({ key: "bulan-ini", from: "2026-11-01", to: T, days: 21 });
    expect(resolvePeriod({ periode: "hari-ini" }, T)).toMatchObject({ from: T, to: T, days: 1 });
    expect(resolvePeriod({ periode: "kemarin" }, T)).toMatchObject({ from: "2026-11-20", to: "2026-11-20" });
    expect(resolvePeriod({ periode: "7-hari" }, T)).toMatchObject({ from: "2026-11-15", to: T, days: 7 });
    expect(resolvePeriod({ periode: "minggu-ini" }, T)).toMatchObject({ from: "2026-11-16", to: T }); // Senin
    expect(resolvePeriod({ periode: "bulan-lalu" }, T)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", days: 31 });
    expect(resolvePeriod({ periode: "3-bulan" }, T)).toMatchObject({ from: "2026-09-01", to: T });
    expect(resolvePeriod({ periode: "tahun-ini" }, T)).toMatchObject({ from: "2026-01-01", to: T, weekly: true });
  });
  it("bulan tertentu & rentang tanggal; rentang terbalik dibetulkan", () => {
    expect(resolvePeriod({ bulan: "2026-02" }, T)).toMatchObject({ key: "bulan", from: "2026-02-01", to: "2026-02-28", days: 28 });
    expect(resolvePeriod({ dari: "2026-11-10", sampai: "2026-11-05" }, T)).toMatchObject({ key: "rentang", from: "2026-11-05", to: "2026-11-10", days: 6 });
  });
  it("pembanding = periode sebelumnya yang sama panjang", () => {
    const p = resolvePeriod({ periode: "7-hari" }, T);
    expect(p).toMatchObject({ prevFrom: "2026-11-08", prevTo: "2026-11-14" });
    const m = resolvePeriod({ periode: "bulan-ini" }, T); // 21 hari
    expect(m).toMatchObject({ prevTo: "2026-10-31", prevFrom: "2026-10-11" });
  });
  it("delta % & bucket grafik (hari; >92 hari per minggu)", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(10, 0)).toBeNull();
    expect(buckets("2026-11-01", "2026-11-05", false).map((b) => b.label)).toEqual(["01", "02", "03", "04", "05"]);
    const w = buckets("2026-01-01", "2026-11-21", true);
    expect(w.length).toBeGreaterThan(40);
    expect(bucketKey("2026-11-21", true)).toBe("2026-11-16");
  });
});
