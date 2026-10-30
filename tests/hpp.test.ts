import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { channelPricing, createsCycle, draftRecipeCost, itemCosts, overheadSummary, productCosting } from "@/lib/hpp";
import { toRecipeQty, useUnitOptions } from "@/lib/itemCatalog";
import { DEFAULT_FEES, channelParams, feePct, monthlyDepreciation, overheadPerPcs, priceBreakdown, suggestPrice } from "@/lib/pricing";
import { saveItemRecord } from "@/lib/items";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Saran harga & potongan marketplace", () => {
  it("potongan default Shopee 14,25% dan TikTok 17,5% + Rp1.250 per pesanan", () => {
    expect(feePct(DEFAULT_FEES.SHOPEE)).toBe(14.25);
    expect(feePct(DEFAULT_FEES.TIKTOK_SHOP)).toBe(17.5);
    expect(DEFAULT_FEES.SHOPEE.perOrder).toBe(1250);
  });
  it("offline: HPP / (1 − margin), dibulatkan ke atas Rp100", () => {
    expect(suggestPrice({ hpp: 7000, marginPct: 30 })).toBe(10000);
    expect(suggestPrice({ hpp: 7001, marginPct: 30 })).toBe(10100);
  });
  it("marketplace: laba bersih setelah potongan = target margin", () => {
    const params = channelParams("SHOPEE", 7000, DEFAULT_FEES, { affiliatePct: 5, adsPct: 3, itemsPerOrder: 2 });
    const price = suggestPrice({ ...params, marginPct: 30 })!;
    const b = priceBreakdown(price, params);
    expect(b.flat).toBe(625); // Rp1.250 dibagi 2 produk per pesanan
    expect(b.pct).toBeGreaterThanOrEqual(30);
    expect(b.pct).toBeLessThan(30.5);
  });
  it("tidak mungkin bila potongan + margin ≥ 100%", () => {
    expect(suggestPrice({ hpp: 1000, marginPct: 60, feePct: 45 })).toBeNull();
  });
  it("offline & reseller tanpa potongan, affiliate & iklan hanya marketplace", () => {
    const rows = channelPricing({ targetMargin: 30, affiliatePct: 5, adsPct: 5, itemsPerOrder: 1 }, 7000, DEFAULT_FEES, new Map([["OFFLINE", { price: BigInt(12000) }]]));
    const off = rows.find((r) => r.channel === "OFFLINE")!;
    expect(off.suggested).toBe(10000);
    expect(off.current).toMatchObject({ fees: 0, affiliate: 0, ads: 0, profit: 5000 });
    expect(rows.find((r) => r.channel === "TIKTOK_SHOP")!.params.feePct).toBe(17.5);
  });
  it("overhead per pcs & penyusutan", () => {
    expect(monthlyDepreciation(6_000_000, 24)).toBe(250_000);
    expect(overheadPerPcs(3_000_000, 6000)).toBe(500);
    expect(overheadPerPcs(3_000_000, 0)).toBe(0);
  });
});

describe("Resep setengah jadi (database)", () => {
  it("HPP setengah jadi dari komponen + upah + overhead, dipakai BOM produk", async () => {
    const gyp = await saveItemRecord({ name: "Gypsum Resep Uji", type: "BAHAN_BAKU", category: "Bahan Utama", unit: "sak", hppUnit: "gram", hppFactor: 20000, minStock: 0, price: 80_000 }, actor);
    const cat = await saveItemRecord({ name: "Cat Resep Uji", type: "BAHAN_BAKU", category: "Cat & Pewarna", unit: "botol", hppUnit: "gram", hppFactor: 1000, minStock: 0, price: 50_000 }, actor);
    const polos = await saveItemRecord({ name: "Figur Polos Uji", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor);
    const dicat = await saveItemRecord({ name: "Figur Dicat Uji", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor);
    // Overhead master Rp300.000/bulan ÷ 3.000 pcs = Rp100/pcs
    const oh = await prisma.overhead.create({ data: { category: "Listrik", name: "Listrik Uji", monthlyAmount: 300_000, outputPerMonth: 3000, active: false } });
    // Polos: 50 gram gypsum (Rp200) + upah 300 + overhead 100 = 600
    await prisma.item.update({ where: { id: polos.id }, data: { recipe: { create: [{ componentId: gyp.id, qty: 50, useUnit: "gram" }] }, recipeLabor: { create: [{ name: "Cetak", rate: 300 }] }, recipeOverhead: { create: [{ overheadId: oh.id }] } } });
    // Dicat: 1 polos (600) + 10 gram cat (Rp500) + upah 80 = 1180
    await prisma.item.update({ where: { id: dicat.id }, data: { recipe: { create: [{ componentId: polos.id, qty: 1 }, { componentId: cat.id, qty: 10 }] }, recipeLabor: { create: [{ name: "Cat", rate: 80 }] } } });
    expect(await draftRecipeCost({ comp: [{ componentId: polos.id, qty: 2, useUnit: null }], labor: [{ taskId: null, name: "x", rate: 50 }], oh: [{ overheadId: oh.id, factor: 0.5 }] })).toBe(1300);
    const costs = await itemCosts();
    expect(costs.get(polos.id)).toMatchObject({ cur: 600, fromRecipe: true });
    expect(costs.get(dicat.id)?.cur).toBe(1180);
    expect(await createsCycle(prisma, polos.id, dicat.id)).toBe(true);
    expect(await createsCycle(prisma, dicat.id, cat.id)).toBe(false);

    const store = await prisma.store.findUniqueOrThrow({ where: { code: "MG" } });
    const box = await saveItemRecord({ name: "Box Uji", type: "BAHAN_BAKU", category: "Kemasan & Packaging", unit: "pcs", hppFactor: 1, minStock: 0, price: 1_000 }, actor);
    const prod = await prisma.product.create({ data: { sku: "UJI-HPP-12", name: "Paket Uji 12", type: "PAKET_12", variant: "MIX", storeId: store.id, packQty: 12, extraPackaging: 200, bom: { create: [{ itemId: dicat.id, qty: 12 }, { itemId: box.id, qty: 1 }] }, recipeLabor: { create: [{ name: "Packing", rate: 500 }] } } });
    const c = await productCosting(prod.id, costs);
    expect(c.material).toBe(14_160);
    expect(c.packaging).toBe(1_200);
    expect(c.labor).toBe(500);
    expect(c.hpp).toBe(15_860);
    expect(c.lines[0].fromRecipe).toBe(true);
  });
  it("overhead per pcs = biaya ÷ output sendiri, cadangan output default", async () => {
    await prisma.overhead.createMany({ data: [{ category: "Listrik", name: "Listrik", monthlyAmount: 600_000, outputPerMonth: 3000 }, { category: "Penyusutan Oven", name: "Oven", monthlyAmount: 250_000, assetCost: 6_000_000, lifeMonths: 24 }] });
    await prisma.setting.update({ where: { key: "overhead_capacity_pcs" }, data: { value: "1000" } });
    expect(await overheadSummary()).toMatchObject({ total: 850_000, capacity: 1000, perPcs: 450 });
  });
  it("satuan pakai dikonversi ke satuan resep", () => {
    expect(useUnitOptions("Kg")).toEqual(["kg", "gram"]);
    expect(useUnitOptions("botol")).toEqual(["botol"]);
    expect(toRecipeQty(500, "gram", "kg")).toBe(0.5);
    expect(toRecipeQty(2, "liter", "ml")).toBe(2000);
    expect(toRecipeQty(3, "pcs", "sak")).toBe(3);
  });
});
