import { describe, expect, it } from "vitest";
import { analyze, loadReturnAnalytics, monthsBetween, type AEvent } from "@/lib/returnAnalytics";
import { jakartaDateTime } from "@/lib/time";

const d = (s: string) => jakartaDateTime(s, "10:00");
const ev = (x: Partial<AEvent>): AEvent => ({ kind: "RETUR", number: "X", date: d("2027-07-05"), marketplace: "SHOPEE", courier: "SPX", city: "Kab. Lamongan", province: "Jawa Timur", reason: "Pembeli mengembalikan barang", goods: 0, refund: 0, shipping: 0, claim: 0, lines: [], ...x });

describe("Analitik retur & komplain", () => {
  it("total, kerugian bersih, rasio & tren bulanan", () => {
    const events = [
      ev({ number: "R1", goods: 20000, shipping: 10000, claim: 5000, lines: [{ itemId: "a", itemName: "Giftbox Mix", sku: "GIFT-MIX", variation: "STANDARD,MIX", qty: 12, bad: 4, loss: 20000 }] }),
      ev({ number: "R2", date: d("2027-08-02"), courier: "J&T", province: "Jawa Barat", city: "Kota Bandung", goods: 7000, lines: [{ itemId: "b", itemName: "Paket 24 Hewan", sku: "MG-24HWN", variation: null, qty: 2, bad: 1, loss: 7000 }] }),
      ev({ number: "K1", kind: "KOMPLAIN", date: d("2027-08-03"), reason: "Pecah / rusak sebagian", refund: 50000, lines: [{ itemId: "a", itemName: "Giftbox Mix", sku: null, variation: null, qty: 4, bad: 4, loss: 50000 }] }),
    ];
    const months = monthsBetween("2027-07", "2027-08");
    expect(months).toEqual(["2027-07", "2027-08"]);
    const a = analyze(events, new Map([["2027-07", 1_000_000], ["2027-08", 2_000_000]]), months);
    expect(a.totals).toMatchObject({ returns: 2, complaints: 1, goods: 27000, refund: 50000, shipping: 10000, loss: 87000, claim: 5000, net: 82000, sales: 3_000_000, ratio: 2.9 });
    expect(a.monthly.map((m) => [m.month, m.loss, m.ratio])).toEqual([["2027-07", 30000, 3], ["2027-08", 57000, 2.85]]);
    // Produk: kerugian baris + ongkir dibagi menurut qty
    const gift = a.byProduct.find((r) => r.key === "a")!;
    expect(gift).toMatchObject({ returns: 1, complaints: 1, qty: 16, bad: 8, loss: 20000 + 10000 + 50000 });
    expect(a.byProvince[0]).toMatchObject({ label: "Jawa Timur", returns: 1, complaints: 1, loss: 80000 });
    expect(a.byCourier.map((r) => r.label)).toEqual(["SPX", "J&T"]);
    expect(a.bySku.map((r) => r.label)).toEqual(["GIFT-MIX · STANDARD,MIX", "MG-24HWN"]);
    expect(a.byReason.map((r) => r.label)).toContain("Komplain: Pecah / rusak sebagian");
    expect(analyze([], new Map(), months).totals.ratio).toBeNull();
  });

  it("data dari database: retur & komplain uji ikut terhitung, rekening pembeli tidak dimuat", async () => {
    const { events } = await loadReturnAnalytics(d("2027-07-01"), d("2027-09-01"));
    const a = analyze(events, new Map(), monthsBetween("2027-07", "2027-08"));
    expect(a.totals.returns).toBeGreaterThan(0);
    expect(a.totals.complaints).toBeGreaterThan(0);
    expect(a.totals.refund).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/081234567890|Pembeli Uji/);
  });
});
