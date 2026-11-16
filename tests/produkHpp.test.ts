import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { bomLineCost, costPerRecipeUnit } from "@/lib/unitcost";
import { itemCosts, productCosting } from "@/lib/hpp";
import { isGram, isPcs, setupProdukHpp, similarNames } from "@/lib/produkHppSetup";

const tag = `HP${Date.now().toString(36).toUpperCase()}`;
const ids: { items: string[]; product?: string } = { items: [] };
const mk = async (name: string, data: { unit: string; type?: "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI"; hppUnit?: string; hppFactor?: number; lastCost?: number }) => {
  const it = await prisma.item.create({ data: { sku: `${tag}-${ids.items.length}`, name: `${name} ${tag}`, unit: data.unit, type: data.type ?? "BAHAN_BAKU", hppUnit: data.hppUnit, hppFactor: data.hppFactor ?? 1, lastCost: BigInt(data.lastCost ?? 0) } });
  ids.items.push(it.id);
  return it;
};

describe("Konversi satuan HPP", () => {
  it("cat kg → gram: 3 g dari Rp100.000/kg = Rp300", () => {
    const cat = { hppFactor: 1000 };
    expect(costPerRecipeUnit(100000, cat)).toBe(100);
    expect(bomLineCost(3, cat, 100000)).toBe(300);
    expect(isGram({ unit: "kg", hppUnit: "gram" })).toBe(true);
  });
  it("pot cat plastik strip isi 6: 5 pcs dari Rp6.000/strip = Rp5.000 (5/6 strip)", () => {
    const pot = { hppFactor: 6 };
    expect(costPerRecipeUnit(6000, pot)).toBe(1000);
    expect(bomLineCost(5, pot, 6000)).toBe(5000);
    expect(isPcs({ unit: "strip", hppUnit: "pcs" })).toBe(true);
    expect(isPcs({ unit: "boks", hppUnit: null })).toBe(false);
  });
  it("nama mirip vs saudara varian", () => {
    expect(similarNames("Satuan Single Pack Transportasi", "Single Pack Transportasi")).toBe(true);
    expect(similarNames("Giftbox Reguler · Standard · Mix", "Giftbox Reguler · Standard · Cewek")).toBe(false);
    expect(similarNames("Paket Single Pack 24 pcs · Hewan", "Paket Single Pack 12 pcs · Hewan")).toBe(false);
  });
});

describe("HPP bertingkat: Cat Plastik → Single Pack → Paket 24", () => {
  beforeAll(async () => {
    const cat = await mk("Cat merah", { unit: "kg", hppUnit: "gram", hppFactor: 1000, lastCost: 100000 });
    const klip = await mk("Plastik klip", { unit: "pcs", lastCost: 50 });
    const kering = await mk("Patung kering", { unit: "pcs", type: "BARANG_DALAM_PROSES", lastCost: 500 });
    const cp = await mk("Cat plastik merah", { unit: "pcs", type: "BARANG_DALAM_PROSES" });
    await prisma.itemRecipeLine.createMany({ data: [{ itemId: cp.id, componentId: cat.id, qty: 3 }, { itemId: cp.id, componentId: klip.id, qty: 1 }] });
    await prisma.recipeLabor.create({ data: { itemId: cp.id, name: "Upah borongan Cat plastik", rate: 15 } });
    const sp = await mk("Single Pack", { unit: "pcs", type: "BARANG_DALAM_PROSES" });
    await prisma.itemRecipeLine.createMany({ data: [{ itemId: sp.id, componentId: cp.id, qty: 1 }, { itemId: sp.id, componentId: kering.id, qty: 1 }] });
    await prisma.recipeLabor.create({ data: { itemId: sp.id, name: "Upah borongan Assembling", rate: 60 } });
    const store = await prisma.store.findFirstOrThrow();
    const p = await prisma.product.create({ data: { sku: `${tag}-P24`, name: `Paket 24 ${tag}`, type: "PAKET_24", variant: "HEWAN", storeId: store.id, bom: { create: [{ itemId: sp.id, qty: 24 }] } } });
    ids.product = p.id;
  });
  afterAll(async () => {
    if (ids.product) await prisma.product.delete({ where: { id: ids.product } });
    await prisma.recipeLabor.deleteMany({ where: { itemId: { in: ids.items } } });
    await prisma.itemRecipeLine.deleteMany({ where: { itemId: { in: ids.items } } });
    await prisma.item.deleteMany({ where: { id: { in: ids.items } } });
  });
  it("bahan + upah borongan per tingkat", async () => {
    const costs = await itemCosts();
    const [, , , cp, sp] = ids.items;
    expect(costs.get(cp)!.cur).toBe(365); // 3 g × Rp100 + klip Rp50 + upah Rp15
    expect(costs.get(sp)!.cur).toBe(925); // Cat plastik 365 + patung kering 500 + upah 60
    const pc = await productCosting(ids.product!, costs);
    expect(pc.material).toBe(925 * 24);
    expect(pc.lines[0].noPrice).toBe(false);
  });
});

describe("Skrip setup:produk-hpp", () => {
  it("pratinjau tidak mengubah data", async () => {
    const before = await prisma.item.count();
    const recipes = await prisma.itemRecipeLine.count();
    try {
      const plan = await setupProdukHpp(prisma, false);
      expect(Array.isArray(plan.bentrok)).toBe(true);
    } catch (e) {
      // Database uji tanpa divisi ASM/GFT/QCP: skrip menolak dengan pesan jelas
      expect(String(e)).toMatch(/Divisi ASM/);
    }
    expect(await prisma.item.count()).toBe(before);
    expect(await prisma.itemRecipeLine.count()).toBe(recipes);
  });
});

import { scaleStockUnit } from "@/lib/produkHppSetup";
describe("Konversi satuan stok gendel → pcs (×200)", () => {
  it("stok ×200, harga ÷200, nilai persediaan tetap", async () => {
    const loc = await prisma.location.create({ data: { code: `${tag}L`, name: `Lok ${tag}` } });
    const it = await mk("Background tes", { unit: "gendel", lastCost: 40000 });
    await prisma.$transaction(async (tx) => {
      const { recordMovement } = await import("@/lib/stock");
      await recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 3, toLocationId: loc.id, unitCost: 40000, ref: `TES:${tag}` }, { id: "system", name: "Tes" });
    });
    const before = await prisma.item.findUniqueOrThrow({ where: { id: it.id } });
    const r = await prisma.$transaction(async (tx) => {
      const x = await scaleStockUnit(tx, before, 200, "pcs");
      await tx.item.update({ where: { id: it.id }, data: { ...x.data, unit: "pcs" } });
      return x;
    });
    expect(r.notes[0]).toMatch(/stok 3 gendel → 600 pcs/);
    const after = await prisma.item.findUniqueOrThrow({ where: { id: it.id } });
    const { qtyAt } = await import("@/lib/stock");
    const q = await qtyAt(prisma, it.id, loc.id);
    expect(q).toBe(600);
    expect(Number(after.avgCost)).toBe(200);
    expect(q * Number(after.avgCost)).toBe(3 * Number(before.avgCost)); // nilai tetap Rp120.000
  });
});
