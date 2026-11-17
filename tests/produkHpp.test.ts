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

import { MIX_BEBAS_KEY, plannedFlow } from "@/lib/shiftReport";
describe("Giftbox Mix: 1 tiap karakter + 1 varian bebas", () => {
  const line = { productId: "p", sku: "MG-001", label: "Mix", col: "Mix", variant: "MIX", patung: 5, qty: 3 };
  it("varian bebas dipilih → 3 box = 3 per karakter + 3 ke pilihan", () => {
    const steps = plannedFlow("GIFTBOX", { gb: [line], [MIX_BEBAS_KEY]: "Cowok" } as never).filter((s) => s.kind === "kering");
    const q = Object.fromEntries(steps.map((s) => [s.key, s.qty]));
    expect(q).toEqual({ Hewan: 3, Cowok: 6, Cewek: 3, Transportasi: 3 });
  });
  it("tanpa pilihan (laporan lama): dibagi rata seperti sebelumnya", () => {
    const steps = plannedFlow("GIFTBOX", { gb: [line] } as never).filter((s) => s.kind === "kering");
    expect(steps.reduce((a, s) => a + s.qty, 0)).toBe(15);
  });
});

import { pickDivision, setupDivisions } from "@/lib/produkHppSetup";
describe("Divisi dicari dari jenis laporan / nama, bukan kode", () => {
  const d = (code: string, name: string, reportTemplate: string | null, active = true) => ({ id: code, code, name, reportTemplate, active });
  const rule = { template: "PACKING", name: /\bpacking\b/i, code: "QCP" };
  it("kode berbeda di production tetap ditemukan", () => {
    expect(pickDivision([d("PCK", "Divisi QC & Packing", "PACKING")], rule)?.code).toBe("PCK");
    expect(pickDivision([d("D07", "divisi PACKING", null)], rule)?.code).toBe("D07");
    expect(pickDivision([d("QCP", "Lain", null)], rule)?.code).toBe("QCP");
    expect(pickDivision([d("PCK", "Packing", "PACKING", false)], rule)).toBeNull();
  });
  it("tidak ketemu → pesan memuat daftar divisi yang ada", async () => {
    const fake = { division: { findMany: async () => [d("CTK", "Divisi Cetak", "CETAK")] } } as never;
    await expect(setupDivisions(fake)).rejects.toThrow(/Assembling \/ Giftbox \/ Packing tidak ditemukan.*CTK "Divisi Cetak"/);
  });
});

import { singlePackCandidates, variantMaterial, variantWord } from "@/lib/produkHppSetup";
describe("Pencocokan longgar barang lama (production)", () => {
  const mkItem = (id: string, sku: string, name: string, unit = "pcs") => ({ id, sku, name, unit });
  it("Single Pack lama: SKU BJ-SAT, nama satuan/figur/single pack, hasil tugas; paket tidak ikut", () => {
    const items = [
      mkItem("a", "BJ-SAT-HEWAN", "Figur Satuan Hewan (jadi)"),
      mkItem("b", "XX-1", "Satuan Single Pack Transportasi"),
      mkItem("c", "MG-041", "Paket Single Pack 12 pcs · Hewan"),
      mkItem("d", "ZZ-9", "Lukis Gypsum Satuan Cewek"),
      mkItem("e", "BB-1", "Cat merah"),
    ];
    expect(singlePackCandidates("Hewan", items).map((x) => x.id)).toEqual(["a"]);
    expect(singlePackCandidates("Transportasi", items).map((x) => x.id)).toEqual(["b"]);
    expect(singlePackCandidates("Cewek", items).map((x) => x.id)).toEqual(["d"]);
    // hasil tugas Assembling (id dari PieceTask.outputItemId) ikut walau namanya tidak mirip
    expect(singlePackCandidates("Cowok", items, ["e"]).map((x) => x.id)).toEqual(["e"]);
    expect(variantWord("Transportasi").test("Klip Transport")).toBe(true);
  });
  it("Background & Klip: nama BG/Background/Klip, satuan gendel didahulukan, plastik klip tidak ikut", () => {
    const items = [
      mkItem("1", "A1", "BG Hewan", "gendel"),
      mkItem("2", "A2", "Klip Transport", "gendel"),
      mkItem("3", "A3", "Plastik klip 2x3", "boks"),
      mkItem("4", "A4", "Background cowok", "pcs"),
      mkItem("5", "A5", "Background cowok lama", "gendel"),
    ];
    expect(variantMaterial("Background", "Hewan", items).map((x) => x.id)).toEqual(["1"]);
    expect(variantMaterial("Klip", "Transportasi", items).map((x) => x.id)).toEqual(["2"]);
    expect(variantMaterial("Background", "Cowok", items).map((x) => x.id)).toEqual(["5", "4"]); // gendel dulu
    expect(variantMaterial("Klip", "Hewan", items)).toEqual([]);
  });
  it("konversi stok boks → slop: ×faktor, harga ÷faktor, nilai persediaan tetap", async () => {
    const loc = await prisma.location.create({ data: { code: `${tag}K`, name: `Lok K ${tag}` } });
    const item = await mk("Klip uji", { unit: "boks", lastCost: 50000 });
    await prisma.$transaction(async (tx) => {
      const { recordMovement } = await import("@/lib/stock");
      await recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 4, toLocationId: loc.id, unitCost: 50000, ref: `TES:${tag}` }, { id: "system", name: "Tes" });
    });
    const before = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    await prisma.$transaction(async (tx) => {
      const x = await scaleStockUnit(tx, before, 0.5, "slop");
      await tx.item.update({ where: { id: item.id }, data: { ...x.data, unit: "slop" } });
    });
    const { qtyAt } = await import("@/lib/stock");
    const q = await qtyAt(prisma, item.id, loc.id);
    const after = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(q).toBe(2); // 4 boks × 0,5
    expect(Number(after.avgCost)).toBe(100000); // harga ÷ 0,5
    expect(q * Number(after.avgCost)).toBe(4 * Number(before.avgCost));
  });
});

import { nextMgSku, renumberItemSku, type ProdukHppPlan } from "@/lib/produkHppSetup";
describe("Seragamkan kode Single Pack ke pola MG-0xx", () => {
  const plan = (): ProdukHppPlan => ({ dibuat: [], diubah: [], resep: [], bentrok: [], menunggu: [], info: [] });
  it("nomor MG berikutnya yang belum terpakai (barang & produk)", () => {
    expect(nextMgSku(new Set(["MG-001", "MG-002", "MG-003", "MG-004"]), 3)).toBe("MG-005");
    expect(nextMgSku(new Set(["MG-004", "MG-005"]), 3)).toBe("MG-006");
    expect(nextMgSku(new Set(), 0)).toBe("MG-001");
  });
  it("kode diganti, alias peta SKU marketplace dibuat, produk terkait tetap", async () => {
    const item = await mk("Single Pack kode uji", { unit: "pcs", type: "BARANG_DALAM_PROSES" });
    const store = await prisma.store.findFirstOrThrow();
    const prod = await prisma.product.create({ data: { sku: `${tag}-SAT`, name: `Satuan ${tag}`, type: "SATUAN", variant: "HEWAN", storeId: store.id, finishedItemId: item.id } });
    const p = plan();
    const next = `MG-9${tag.slice(-2).replace(/\D/g, "0")}${Date.now() % 100}`;
    await prisma.$transaction((tx) => renumberItemSku(tx, item, next, p));
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).sku).toBe(next);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: prod.id } })).sku).toBe(`${tag}-SAT`);
    const alias = await prisma.marketplaceSkuMap.findUniqueOrThrow({ where: { key: `${item.sku.toUpperCase()}|` } });
    expect(alias.itemId).toBe(item.id);
    expect(p.info[0]).toMatch(/Alias .* dibuat/);
    // Dijalankan lagi (alias sudah ada): tidak error, tidak dobel
    const p2 = plan();
    await prisma.$transaction((tx) => renumberItemSku(tx, { ...item, sku: item.sku }, `${next}X`, p2));
    expect(await prisma.marketplaceSkuMap.count({ where: { itemId: item.id } })).toBe(1);
    // bersihkan
    await prisma.marketplaceSkuMap.deleteMany({ where: { itemId: item.id } });
    await prisma.product.delete({ where: { id: prod.id } });
  });
  it("barang belum terhubung ke produk: kode TIDAK diganti, dilaporkan", async () => {
    const item = await mk("Single Pack tanpa produk", { unit: "pcs", type: "BARANG_DALAM_PROSES" });
    const p = plan();
    const ok = await prisma.$transaction((tx) => renumberItemSku(tx, item, "MG-999", p));
    expect(ok).toBe(false);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).sku).toBe(item.sku);
    expect(p.bentrok[0]).toMatch(/TIDAK diganti/);
    expect(await prisma.marketplaceSkuMap.count({ where: { itemId: item.id } })).toBe(0);
  });
});
