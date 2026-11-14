import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, qtyAt } from "@/lib/stock";
import { monitorDaily, monitorOf, monitorSum, parseWork, plannedFlow, summaryOf, workLines, type ReportCatalogs, type WorkData } from "@/lib/shiftReport";
import { FLOW_SETTING, postShiftWork } from "@/lib/shiftReportFlow";
import {
  CATALOG, GIFTBOX_FAMILY, PAKET_FAMILY, SATUAN_FAMILY,
  applySkuPlan, catalogGrid, combos, copyRecipe, ensureFamily, familyInclude, familyMatrix, generateMissingSkus, planFamilySkus, reportCatalogs, saveBulkPrices, skuAttrs, skuName,
} from "@/lib/productFamily";
import { addWaterToKeringRecipes, ensureWaterItem } from "@/lib/water";
import { flowItem } from "@/lib/shiftReportFlow";
import { productCosting } from "@/lib/hpp";
import { dateOnly, jakartaDateTime } from "@/lib/time";

/** Contoh laporan 10 Nov (format lama) */
const PACKING_10NOV: WorkData = { resi: { shopee: 57, tiktok: 81 }, mix: { p12: 5, p24: 17, p48: 9, p96: 1 }, satuan: { cowok: 22, cewek: 23, transportasi: 200, hewan: 171 } };
const GIFTBOX_10NOV: WorkData = { resi: { shopee: null, tiktok: null }, giftbox: { MIX: 40, CEW: 20, "HWN-PLT": 39 } };

describe("Katalog varian (murni)", () => {
  it("kombinasi & atribut SKU", () => {
    expect(combos([["A", "B"], ["1", "2", "3"]])).toHaveLength(6);
    expect(combos(CATALOG[0].axes.map((a) => a.options))).toHaveLength(40);
    const opts = CATALOG[2].axes.map((a) => a.options);
    expect(skuAttrs({ type: "PAKET_12", patungQty: 12 }, [opts[0][3], opts[1][1]])).toEqual({ packQty: 96, type: "PAKET_96", variant: "HEWAN" });
    expect(skuAttrs({ type: "GIFTBOX", patungQty: 5 }, [{ name: "Reguler" }, { name: "Standard" }, { name: "Mix", variant: "MIX" }])).toEqual({ packQty: 5, type: "GIFTBOX", variant: "MIX" });
    expect(skuName("Giftbox", [{ name: "Reguler" }, { name: "Standard" }, { name: "Cowok" }])).toBe("Giftbox Reguler · Standard · Cowok");
  });

  it("monitoring laporan 10 Nov: resi 138, patung packing 1.412, giftbox 99 box = 495 patung", () => {
    expect(monitorOf("PACKING", PACKING_10NOV)).toMatchObject({ shopee: 57, tiktok: 81, resi: 138, patung: 1412 });
    expect(summaryOf("PACKING", PACKING_10NOV).find((s) => s.label === "Total patung")?.value).toBe(1412);
    const g = monitorOf("GIFTBOX", GIFTBOX_10NOV)!;
    expect(g).toMatchObject({ resi: 0, patung: 495 });
    expect(Object.values(g.byVariant).reduce((a, b) => a + b, 0)).toBe(495);
    expect(monitorOf("PRODUKSI", {})).toBeNull();
    const days = monitorDaily([
      { date: dateOnly("2026-11-10"), division: "Packing", template: "PACKING", work: PACKING_10NOV },
      { date: dateOnly("2026-11-10"), division: "Giftbox", template: "GIFTBOX", work: GIFTBOX_10NOV },
    ], "2026-11-09", "2026-11-10", ["Packing", "Giftbox"]);
    expect(days.map((d) => [d.date, d.total.resi, d.total.patung])).toEqual([["2026-11-09", 0, 0], ["2026-11-10", 138, 1907]]);
    expect(monitorSum(days).byDivision.Giftbox.patung).toBe(495);
  });

  it("isian katalog: baris SKU, total patung dari jumlah patung per SKU, langkah stok per karakter", () => {
    const cat: ReportCatalogs = {
      pk: { family: PAKET_FAMILY, cols: ["Mix", "Hewan"], rows: [{ label: "24 pcs", cells: [{ productId: "p24m", sku: "MG-1", name: "x", patung: 24, variant: "MIX" }, { productId: "p24h", sku: "MG-2", name: "y", patung: 24, variant: "HEWAN" }] }] },
      st: { family: SATUAN_FAMILY, cols: ["Cowok"], rows: [{ label: "", cells: [{ productId: "sc", sku: "MG-3", name: "z", patung: 1, variant: "COWOK" }] }] },
    };
    const fd: Record<string, string> = { "w.resi.shopee": "10", "w.pk.p24m": "2", "w.pk.p24h": "1", "w.st.sc": "7", "w.pk.bukan": "9" };
    const work = parseWork("PACKING", (k) => fd[k] ?? null, cat);
    expect((work.pk as unknown[]).length).toBe(2);
    expect(monitorOf("PACKING", work)).toMatchObject({ resi: 10, patung: 48 + 24 + 7 });
    expect(workLines("PACKING", work)).toContain("TOTAL PATUNG: 79 pcs");
    // Dikelompokkan per paket: satu baris per grup dengan totalnya
    expect(workLines("PACKING", work)).toContain("PATUNG MIX (PAKET): TOTAL 72 pcs");
    expect(workLines("PACKING", work)).toContain("• 24 pcs: Mix 2 (48) · Hewan 1 (24) = 72");
    expect(workLines("PACKING", work)).toContain("PATUNG SATUAN: TOTAL 7 pcs");
    // Isian lama yang kosong tidak tampil lagi
    expect(workLines("PACKING", work).some((l) => l.startsWith("PATUNG MIX:"))).toBe(false);
    const q = Object.fromEntries(plannedFlow("PACKING", work).map((s) => [s.key, s.qty]));
    expect(q).toEqual({ Hewan: 12 + 24, Cowok: 12 + 7, Transportasi: 12, Cewek: 12 });
  });
});

describe("Katalog produk di database", () => {
  let actor: { id: string; name: string };
  let storeId: string;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    storeId = (await prisma.store.findFirstOrThrow({ orderBy: { code: "asc" } })).id;
  });

  it("isi katalog: 40 + 4 + 20 SKU, produk lama masuk induk (tidak dobel), aman diulang", async () => {
    const before = await prisma.product.findMany({ select: { id: true, sku: true, type: true, variant: true } });
    const satuanCowok = before.find((p) => p.type === "SATUAN" && p.variant === "COWOK");
    await prisma.$transaction(async (tx) => {
      for (const spec of CATALOG) {
        const f = await ensureFamily(tx, spec);
        await applySkuPlan(tx, f, await planFamilySkus(tx, f, spec, storeId), { storeId, unit: spec.unit });
      }
    }, { timeout: 60000 });
    const fams = await prisma.productFamily.findMany({ include: familyInclude });
    const count = (name: string) => fams.find((f) => f.name === name)!.products.length;
    expect([count(GIFTBOX_FAMILY), count(SATUAN_FAMILY), count(PAKET_FAMILY)]).toEqual([40, 4, 20]);
    // Produk lama tetap (tidak dihapus), dan satuan Cowok lama dipakai sebagai SKU induk
    const after = await prisma.product.findMany({ select: { id: true, familyId: true } });
    expect(before.every((p) => after.some((x) => x.id === p.id))).toBe(true);
    const linked = after.filter((x) => x.familyId && before.some((p) => p.id === x.id)).length;
    expect(linked).toBeGreaterThan(0);
    expect(after.length).toBe(before.length + 64 - linked);
    if (satuanCowok) expect((await prisma.product.findUniqueOrThrow({ where: { id: satuanCowok.id } })).familyId).toBe(fams.find((f) => f.name === SATUAN_FAMILY)!.id);
    const gb = fams.find((f) => f.name === GIFTBOX_FAMILY)!;
    expect(gb.products.every((p) => p.packQty === 5 && p.type === "GIFTBOX" && p.finishedItemId)).toBe(true);
    const p96 = fams.find((f) => f.name === PAKET_FAMILY)!.products.find((p) => p.packQty === 96 && p.variant === "HEWAN");
    expect(p96?.type).toBe("PAKET_96");
    // Diulang: tidak ada SKU baru
    expect(await generateMissingSkus(gb.id)).toEqual({ created: 0, linked: 0 });
    // Pilihan baru → SKU baru hanya untuk kombinasi itu
    const tipe = gb.axes.find((a) => a.name === "Tipe")!;
    await prisma.variantOption.create({ data: { axisId: tipe.id, name: "Premium", sortOrder: 9 } });
    expect(await generateMissingSkus(gb.id)).toEqual({ created: 20, linked: 0 });
    const full = await prisma.productFamily.findUniqueOrThrow({ where: { id: gb.id }, include: familyInclude });
    expect(familyMatrix(full).every((m) => m.product)).toBe(true);
    expect(catalogGrid(full).rows).toHaveLength(12);
    expect(catalogGrid(full).cols).toEqual(["Mix", "Cewek", "Cowok", "Hewan", "Transportasi"]);
  });

  it("salin resep ke varian lain + harga massal (hanya yang berubah)", async () => {
    const f = await prisma.productFamily.findFirstOrThrow({ where: { name: GIFTBOX_FAMILY }, include: familyInclude });
    const [src, a, b] = f.products;
    const gypsum = await prisma.item.findFirstOrThrow({ where: { type: "BAHAN_BAKU" } });
    await prisma.bomLine.create({ data: { productId: src.id, itemId: gypsum.id, qty: 2 } });
    await prisma.recipeLabor.create({ data: { productId: src.id, name: "Cat", rate: 1000n } });
    expect(await prisma.$transaction((tx) => copyRecipe(tx, src.id, [a.id, b.id, src.id]))).toBe(2);
    const bom = await prisma.bomLine.findMany({ where: { productId: a.id } });
    expect(bom.map((x) => [x.itemId, Number(x.qty)])).toEqual([[gypsum.id, 2]]);
    expect((await productCosting(b.id)).labor).toBe(1000);
    // Resep SKU tujuan tetap bisa diubah sendiri
    await prisma.bomLine.updateMany({ where: { productId: b.id }, data: { qty: 3 } });
    expect(Number((await prisma.bomLine.findFirstOrThrow({ where: { productId: src.id } })).qty)).toBe(2);
    await expect(prisma.$transaction((tx) => copyRecipe(tx, f.products[5].id, [a.id]))).rejects.toThrow(/belum punya resep/);

    const rows = [{ productId: a.id, channel: "OFFLINE", price: 25000, hpp: 0 }, { productId: a.id, channel: "SHOPEE", price: 30000, hpp: 0 }, { productId: b.id, channel: "OFFLINE", price: 0, hpp: 0 }];
    expect(await prisma.$transaction((tx) => saveBulkPrices(tx, rows, "uji"))).toBe(2);
    expect(await prisma.$transaction((tx) => saveBulkPrices(tx, rows, "uji"))).toBe(0);
    expect(await prisma.$transaction((tx) => saveBulkPrices(tx, [{ ...rows[0], price: 26000 }], "uji"))).toBe(1);
    expect(await prisma.priceHistory.count({ where: { productId: a.id, channel: "OFFLINE" } })).toBe(2);
  });

  it("Air: bahan baku liter/ml Rp0, masuk resep patung kering sekali saja", async () => {
    await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cowok" }));
    const w = await prisma.$transaction((tx) => ensureWaterItem(tx));
    expect(w.item).toMatchObject({ name: "Air", unit: "liter", hppUnit: "ml", type: "BAHAN_BAKU" });
    expect((await prisma.$transaction((tx) => ensureWaterItem(tx))).created).toBe(false);
    const added = await prisma.$transaction((tx) => addWaterToKeringRecipes(tx, w.item.id, 120));
    expect(added.some((a) => a.sku === "SJ-PTG-COWOK")).toBe(true);
    expect(await prisma.$transaction((tx) => addWaterToKeringRecipes(tx, w.item.id, 120))).toEqual([]);
    const line = await prisma.itemRecipeLine.findFirstOrThrow({ where: { componentId: w.item.id, item: { sku: "SJ-PTG-COWOK" } } });
    expect(Number(line.qty)).toBe(120);
  });

  it("laporan Giftbox dari katalog → patung kering keluar per Series, SKU giftbox masuk lalu keluar", async () => {
    const cats = await reportCatalogs("GIFTBOX");
    const g = cats.gb!;
    const reg = g.rows.find((r) => r.label === "Reguler · Standard")!;
    const cowok = reg.cells[g.cols.indexOf("Cowok")]!;
    const mix = reg.cells[g.cols.indexOf("Mix")]!;
    const work = parseWork("GIFTBOX", (k) => ({ [`w.gb.${cowok.productId}`]: "3", [`w.gb.${mix.productId}`]: "2" })[k] ?? null, cats);
    expect(summaryOf("GIFTBOX", work).map((s) => [s.label, s.value])).toEqual([["Total giftbox", 5], ["Total patung", 25]]);

    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const { wip, finished } = await locationSettings(prisma);
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cowok" }));
    const k0 = await qtyAt(prisma, kering, wip!);
    const div = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
    const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    const r = await prisma.shiftReport.create({ data: { date: dateOnly("2027-11-02"), shiftId: s1, divisionId: div.id, createdBy: "uji", work } });
    await postShiftWork(r.id, actor, jakartaDateTime("2027-11-03", "08:00"));
    // Cowok 3 box × 5 = 15, Mix 2 box × 5 = 10 dibagi rata (Cowok dapat 3)
    expect(await qtyAt(prisma, kering, wip!)).toBe(k0 - 15 - 3);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: cowok.productId } });
    const moves = await prisma.stockMovement.findMany({ where: { ref: `LPH:${r.id}:1`, itemId: p.finishedItemId! } });
    expect(moves.map((m) => m.type).sort()).toEqual(["HASIL_PRODUKSI", "PENGELUARAN"]);
    expect(await qtyAt(prisma, p.finishedItemId!, finished!)).toBe(0);
    await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
  });
});
