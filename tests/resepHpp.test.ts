import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { itemCosts, laborRate, productCosting } from "@/lib/hpp";
import { auditRecipes, coverageOf, recipeDuplicateErrors } from "@/lib/recipeRules";

const tag = Date.now().toString(36).slice(-5).toUpperCase();

describe("Resep HPP: otomatis dari tarif, anti dobel, audit", () => {
  it("laborRate: otomatis dari tarif tugas kecuali override", () => {
    expect(laborRate({ rate: 10n, task: { ratePerPcs: 60n } })).toBe(60);
    expect(laborRate({ rate: 10n, override: true, task: { ratePerPcs: 60n } })).toBe(10);
    expect(laborRate({ rate: 10n, task: null })).toBe(10);
  });

  it("upah mengikuti tarif terbaru; overhead tahap sebelumnya tidak boleh dobel; rincian bertingkat; audit", async () => {
    const store = await prisma.store.findFirstOrThrow();
    const div = await prisma.division.create({ data: { code: `RH${tag}`, name: `Div RH ${tag}` } });
    const task = await prisma.pieceTask.create({ data: { code: `RH${tag}`, name: `Tugas RH A ${tag}`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n } });
    const task2 = await prisma.pieceTask.create({ data: { code: `RI${tag}`, name: `Tugas RH B ${tag}`, divisionId: div.id, ratePerPcs: 40n, workerRate: 40n, coordinatorRate: 0n, driverRate: 0n } });
    const oh = await prisma.overhead.create({ data: { category: "Listrik", name: `Listrik RH ${tag}`, monthlyAmount: 1_000_000n, outputPerMonth: 1000 } });
    const bahan = await prisma.item.create({ data: { sku: `RH-B-${tag}`, name: `Bahan RH ${tag}`, type: "BAHAN_BAKU", unit: "pcs", avgCost: 100 } });
    // Setengah jadi: bahan 1 pcs + upah Assembling (otomatis dari tarif) + overhead Listrik
    const semi = await prisma.item.create({ data: { sku: `RH-S-${tag}`, name: `Single Pack RH ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs" } });
    await prisma.itemRecipeLine.create({ data: { itemId: semi.id, componentId: bahan.id, qty: 1 } });
    await prisma.recipeLabor.create({ data: { itemId: semi.id, taskId: task.id, name: task.name, rate: 60n } });
    await prisma.recipeOverhead.create({ data: { itemId: semi.id, overheadId: oh.id, factor: 1 } });
    // Produk: 24 Single Pack, tanpa upah/overhead sendiri
    const prod = await prisma.product.create({ data: { sku: `RH-P-${tag}`, name: `Paket RH ${tag}`, type: "PAKET_24", variant: "HEWAN", storeId: store.id, bom: { create: [{ itemId: semi.id, qty: 24 }] } } });

    // Tarif berubah 60 → 80: HPP setengah jadi ikut (upah otomatis, bukan nilai tersimpan)
    const before = (await itemCosts()).get(semi.id)!;
    await prisma.pieceTask.update({ where: { id: task.id }, data: { ratePerPcs: 80n } });
    const after = (await itemCosts()).get(semi.id)!;
    expect(after.cur - before.cur).toBe(20);
    expect(after.labor).toBe(80);
    expect(after.overhead).toBe(1000); // 1.000.000 / 1000
    // Override Owner tidak ikut berubah
    await prisma.recipeLabor.updateMany({ where: { itemId: semi.id }, data: { override: true, rate: 55n } });
    expect((await itemCosts()).get(semi.id)!.labor).toBe(55);
    await prisma.recipeLabor.updateMany({ where: { itemId: semi.id }, data: { override: false } });

    // Rincian bertingkat di produk: upah & overhead hanya dari setengah jadi ×24
    const pc = await productCosting(prod.id);
    expect([pc.embedded.labor, pc.embedded.overhead, pc.embedded.material]).toEqual([80 * 24, 1000 * 24, 100 * 24]);
    expect([pc.labor, pc.overhead]).toEqual([0, 0]);

    // Anti dobel: upah & overhead yang sudah ada di setengah jadi ditolak di resep produk
    const cov = await coverageOf(prisma, [semi.id]);
    expect([[...cov.tasks.keys()], [...cov.overheads.keys()]]).toEqual([[task.id], [oh.id]]);
    const errs = await recipeDuplicateErrors(prisma, { comp: [{ componentId: semi.id }], labor: [{ taskId: task.id, name: task.name }, { taskId: task2.id, name: task2.name }], oh: [{ overheadId: oh.id }] });
    expect(errs.length).toBe(2);
    expect(errs.join(" ")).toMatch(/Upah .*sudah dihitung di setengah jadi/);
    expect(errs.join(" ")).toMatch(/Overhead .*sudah dihitung di setengah jadi/);
    // Upah lain yang belum dihitung → boleh
    expect(await recipeDuplicateErrors(prisma, { comp: [{ componentId: semi.id }], labor: [{ taskId: task2.id, name: task2.name }], oh: [] })).toEqual([]);

    // Audit mendeteksi dobel pada resep produk yang sudah terlanjur dobel
    await prisma.recipeLabor.create({ data: { productId: prod.id, taskId: task.id, name: task.name, rate: 80n } });
    await prisma.recipeOverhead.create({ data: { productId: prod.id, overheadId: oh.id, factor: 1 } });
    const found = (await auditRecipes()).filter((x) => x.ownerId === prod.id);
    expect(found.map((x) => x.kind).sort()).toEqual(["DOBEL_OVERHEAD", "DOBEL_UPAH"]);
  });
});
