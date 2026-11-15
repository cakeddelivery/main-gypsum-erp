import { describe, expect, it } from "vitest";
import { classifyCodes, findPlace, matchItem, mergeLabel, normalizeCity, normalizeProvince, parseLabelText, sanitizeLabel, skuKey, type CatalogEntry } from "@/lib/returnLabel";
import { inspectionValues } from "@/lib/returns";

const catalog: CatalogEntry[] = [
  { itemId: "gift-mix", sku: "MG-GB-STD-MIX", name: "Giftbox Standard Mix", words: ["Giftbox", "Standard", "Mix"] },
  { itemId: "gift-cew", sku: "MG-GB-STD-CEW", name: "Giftbox Standard Cewek", words: ["Giftbox", "Standard", "Cewek"] },
  { itemId: "gift-cow", sku: "MG-GB-STD-COW", name: "Giftbox Standard Cowok", words: ["Giftbox", "Standard", "Cowok"] },
  { itemId: "p24-hewan", sku: "MG-P24-HWN", name: "Paket 24 Hewan", words: ["Paket", "24", "Hewan"] },
  { itemId: "p12-hewan", sku: "MG-P12-HWN", name: "Paket 12 Hewan", words: ["Paket", "12", "Hewan"] },
];

describe("Baca label retur", () => {
  it("barcode: resi SPX/J&T vs no. pesanan Shopee/TikTok", () => {
    expect(classifyCodes(["SPXID054123456789", "2411147ABCDE12"])).toMatchObject({ trackingNo: "SPXID054123456789", courier: "SPX", orderNo: "2411147ABCDE12", marketplace: "SHOPEE" });
    expect(classifyCodes(["JX3456789012", "576123456789012345"])).toMatchObject({ trackingNo: "JX3456789012", courier: "J&T", orderNo: "576123456789012345", marketplace: "TIKTOK" });
    expect(classifyCodes(["CGK1234567890123"]).trackingNo).toBe("CGK1234567890123");
  });
  it("kota/kab & provinsi saja; alamat jalan ditolak", () => {
    expect(normalizeCity("KAB. LAMONGAN")).toBe("Kab. Lamongan");
    expect(normalizeCity("Kabupaten Sidoarjo")).toBe("Kab. Sidoarjo");
    expect(normalizeCity("KOTA SURABAYA")).toBe("Kota Surabaya");
    expect(normalizeCity("Jl. Mawar No. 5 RT 02")).toBeNull();
    expect(normalizeProvince("JAWA TIMUR")).toBe("Jawa Timur");
    expect(normalizeProvince("Prov. Papua Barat Daya")).toBe("Papua Barat Daya");
    expect(normalizeProvince("jatim")).toBe("Jawa Timur");
    expect(findPlace("Budi Santoso 0812xxxx\nJl. Melati 3, Kec. Babat\nKAB. LAMONGAN, JAWA TIMUR 62271")).toEqual({ city: "Kab. Lamongan", province: "Jawa Timur" });
  });
  it("teks OCR 3 contoh label: Shopee JTR, Shopee SPX, TikTok/Tokopedia J&T", () => {
    const jtr = parseLabelText("Shopee\nJTR\nNo. Resi: JT1234567890123\nNo. Pesanan: 2411147ABCDE12\nKota Surabaya, Jawa Timur\nSKU: GIFT-MIX Variasi: STANDARD,MIX Qty: 12\nBBWP Bubble + Dus 1");
    expect(jtr).toMatchObject({ marketplace: "SHOPEE", courier: "J&T Cargo", orderNo: "2411147ABCDE12", city: "Kota Surabaya", province: "Jawa Timur" });
    expect(jtr.lines[0]).toMatchObject({ sku: "GIFT-MIX", variation: "STANDARD,MIX", qty: 12 });
    const spx = parseLabelText("Shopee Xpress SPX\nSPXID054123456789\nKAB. GRESIK JAWA TIMUR\nMG-24HWN Hewan 24 Pcs 2");
    expect(spx).toMatchObject({ courier: "SPX", trackingNo: "SPXID054123456789", city: "Kab. Gresik", province: "Jawa Timur" });
    expect(spx.lines[0]).toMatchObject({ sku: "MG-24HWN", qty: 2 });
    const tt = parseLabelText("TikTok Shop Tokopedia\nJ&T Express\nJX3456789012\nOrder ID: 576123456789012345\nKOTA BANDUNG, JAWA BARAT\nSeller SKU GIFT-CEW, STANDARD,CEWEK, 1");
    expect(tt).toMatchObject({ marketplace: "TIKTOK", courier: "J&T", trackingNo: "JX3456789012", orderNo: "576123456789012345", city: "Kota Bandung", province: "Jawa Barat" });
    expect(tt.lines[0]).toMatchObject({ sku: "GIFT-CEW", variation: "STANDARD,CEWEK", qty: 1 });
  });
  it("hasil AI dibersihkan: kolom data pribadi dibuang", () => {
    const x = sanitizeLabel({ marketplace: "Shopee", courier: "SPX", trackingNo: "spxid 054123456789", city: "Jl. Kenanga 9", province: "jawa timur", name: "Budi", phone: "0812", address: "Jl. Kenanga", lines: [{ sku: "gift-mix", variation: "standard,mix", qty: "12" }] });
    expect(x).toEqual({ marketplace: "SHOPEE", courier: "SPX", trackingNo: "SPXID054123456789", orderNo: null, city: null, province: "Jawa Timur", lines: [{ sku: "GIFT-MIX", variation: "STANDARD,MIX", name: null, qty: 12 }] });
    expect(JSON.stringify(x)).not.toMatch(/Budi|0812|Kenanga/);
    expect(mergeLabel({ trackingNo: "A1" }, { trackingNo: "B2", city: "Kota X" }).city).toBe("Kota X");
  });
  it("SKU marketplace → produk ERP (singkatan, variasi, peta yang dipelajari)", () => {
    expect(matchItem({ sku: "GIFT-MIX", variation: "STANDARD,MIX", name: null }, catalog)?.itemId).toBe("gift-mix");
    expect(matchItem({ sku: "GIFT-CEW", variation: "STANDARD,CEWEK", name: null }, catalog)?.itemId).toBe("gift-cew");
    expect(matchItem({ sku: "MG-24HWN", variation: null, name: "Hewan 24 Pcs" }, catalog)?.itemId).toBe("p24-hewan");
    // Tidak yakin → null (pengguna memilih); peta yang pernah dikonfirmasi menang
    expect(matchItem({ sku: "BBWP", variation: null, name: "Bubble + Dus" }, catalog)).toBeNull();
    expect(matchItem({ sku: "XYZ-1", variation: "A", name: null }, catalog, new Map([[skuKey("XYZ-1", "A"), "gift-cow"]]))).toEqual({ itemId: "gift-cow", by: "PETA" });
  });
  it("nilai hasil periksa: baik ke stok, rusak + tidak ada = kerugian", () => {
    expect(inspectionValues([{ qty: 12, goodQty: 8, damagedQty: 3, unitCost: 5000 }, { qty: 2, goodQty: 2, damagedQty: 0, unitCost: 7000 }])).toEqual({ good: 54000, loss: 20000 });
    expect(() => inspectionValues([{ qty: 2, goodQty: 2, damagedQty: 1, unitCost: 1 }])).toThrow(/melebihi/);
  });
});
