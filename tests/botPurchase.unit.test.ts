import { describe, expect, it } from "vitest";
import { extractAmount, extractTransaction, hasExplicitAmount, mergeReceipt } from "@/lib/extract";
import { detectPurchase, extractQty, extractSplits, type PurchaseItem } from "@/lib/botPurchase";

const items: PurchaseItem[] = [
  { id: "g", sku: "BB-0001", name: "Gypsum", unit: "sak", supplierId: null },
  { id: "gp", sku: "BB-0002", name: "Gypsum Putih", unit: "sak", supplierId: null },
  { id: "pl", sku: "BB-0003", name: "Plastik Kemasan", unit: "pcs", supplierId: null },
  { id: "cat", sku: "BB-0004", name: "Cat Tembok Merah", unit: "kg", supplierId: null },
];

describe("nominal tidak tertukar dengan jumlah barang / tahun", () => {
  it("2000 pcs dan tahun 2026 bukan nominal", () => {
    expect(extractAmount("beli plastik kemasan 2000 pcs")).toBeNull();
    expect(extractAmount("beli plastik 2000 pcs tgl 4 nov 2026")).toBeNull();
    expect(extractAmount("beli plastik 2.000 pcs tahun 2026")).toBeNull();
    expect(extractAmount("bayar ke seabank 0006")).toBeNull();
    expect(extractAmount("beli plastik 2000 pcs 450rb")).toBe(450000);
    expect(extractAmount("beli gypsum 10 sak rp 850.000")).toBe(850000);
    expect(extractAmount("beli gypsum 10 sak 850.000")).toBe(850000);
    expect(extractAmount("bayar listrik 350000")).toBe(350000);
  });
  it("nominal di bukti dipakai bila caption tidak menulis nominal jelas", () => {
    const text = "beli plastik kemasan 2000 pcs";
    expect(hasExplicitAmount(text)).toBe(false);
    const ex = mergeReceipt(extractTransaction(text, [], []), text, { amount: 640000, date: "2026-11-04", direction: "KELUAR", account: null, counterparty: "Toko Plastik" }, [], []);
    expect(ex.amount).toBe(640000);
    const text2 = "beli plastik 2000 pcs 600rb";
    const text3 = "Angsur kardus (-4.370.000)";
    expect(mergeReceipt(extractTransaction(text3, [], []), text3, { amount: 2000000, date: "2026-11-02", direction: "KELUAR", account: null, counterparty: "Hendra C Thesno" }, [], []).amount).toBe(2000000);
    expect(mergeReceipt(extractTransaction(text2, [], []), text2, { amount: 640000, date: "2026-11-04", direction: "KELUAR", account: null, counterparty: null }, [], []).amount).toBe(600000);
  });
});

describe("deteksi pembelian bahan baku dari master data", () => {
  it("mengenali barang & jumlahnya", () => {
    const h = detectPurchase("beli plastik kemasan 2000 pcs", items, "KELUAR");
    expect(h?.item.id).toBe("pl");
    expect(h?.qty).toBe(2000);
    expect(extractQty("gypsum 1.500 kg")).toBe(1500);
  });
  it("memilih nama paling spesifik dan tidak menghitung dua kali", () => {
    const h = detectPurchase("pembelian gypsum putih 10 sak", items, "KELUAR");
    expect(h?.item.id).toBe("gp");
    expect(h?.others).toEqual([]);
  });
  it("kata utama nama barang cukup (urutan bebas)", () => {
    expect(detectPurchase("belanja cat merah tembok 5 kg", items, "KELUAR")?.item.id).toBe("cat");
  });
  it("bukan pembelian bila tidak ada kata beli/jumlah, uang masuk, atau barang tidak ada di master", () => {
    expect(detectPurchase("gypsum", items, "KELUAR")).toBeNull();
    expect(detectPurchase("terima pembayaran gypsum 10 sak", items, "MASUK")).toBeNull();
    expect(detectPurchase("beli bensin 2 liter", items, "KELUAR")).toBeNull();
    expect(detectPurchase("bayar gypsum 10 sak", items, "KELUAR")?.item.id).toBe("g");
  });
});

describe("rincian dari caption per baris", () => {
  const cats = [
    { id: "ongkir", name: "Ongkos Kirim", direction: "KELUAR" as const, keywords: "ongkir,ongkos kirim" },
    { id: "bahan", name: "Pembelian Bahan Baku", direction: "KELUAR" as const, keywords: "dus,kardus,plastik" },
    { id: "lain", name: "Beban Lain-lain", direction: "KELUAR" as const, keywords: "lain-lain" },
  ];
  it("memecah 3 baris dengan nominal k", () => {
    const s = extractSplits("beli dus bekas 5k\ngalon cleo 20k\nongkir gypsum 10k", cats, items, "KELUAR");
    expect(s.map((x) => x.amount)).toEqual([5000, 20000, 10000]);
    expect(s[0]).toMatchObject({ label: "dus bekas", categoryId: "bahan" });
    expect(s[1].categoryId).toBeNull();
    expect(s[2].categoryId).toBe("ongkir");
  });
  it("baris bahan baku + jumlah menjadi stok", () => {
    const s = extractSplits("plastik kemasan 200 pcs 150rb\nongkir 10rb", cats, items, "KELUAR");
    expect(s[0]).toMatchObject({ itemId: "pl", qty: 200, amount: 150000 });
  });
  it("satu baris saja bukan rincian", () => {
    expect(extractSplits("bayar listrik 350rb", cats, items, "KELUAR")).toEqual([]);
    expect(extractSplits("terima 100rb\njual 50rb", cats, items, "MASUK")).toEqual([]);
  });
});
