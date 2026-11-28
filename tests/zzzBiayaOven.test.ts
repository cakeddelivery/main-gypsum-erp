import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { biayaGypsum, biayaLpgPerPeriode, pasangBiayaOven, periodes, rencanaPasang } from "@/lib/biayaOven";
import { perbaikiResepDobel, rencanaResepDobel } from "@/lib/perbaikiResepDobel";
import { auditRecipes } from "@/lib/recipeRules";

const tag = `BO${Date.now().toString(36).toUpperCase()}`;
const year = 2060 + Math.floor(Math.random() * 30);
const created: { items: string[]; products: string[] } = { items: [], products: [] };
afterAll(async () => {
  await prisma.product.updateMany({ where: { id: { in: created.products } }, data: { active: false } });
  await prisma.item.updateMany({ where: { id: { in: created.items } }, data: { active: false } });
});

describe("Biaya oven (LPG) & gypsum per pcs", () => {
  const now = new Date(`${year}-06-20T05:00:00Z`);
  it("periode: 6 bulan + 30 hari terakhir", () => {
    const p = periodes(now);
    expect(p).toHaveLength(7);
    expect(p[5].label).toBe(`${year}-06`);
    expect(p[6].label).toBe("30 hari terakhir");
  });

  it("LPG per pcs = (isi ulang dibayar + estimasi menunggu) ÷ panen laporan Oven; pembelian item tidak dobel", async () => {
    const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } });
    const shifts = await prisma.shift.findMany({ orderBy: { code: "asc" }, take: 2 });
    for (const [i, s] of shifts.entries()) {
      await prisma.shiftReport.create({ data: { date: new Date(`${year}-06-1${i + 1}T00:00:00Z`), shiftId: s.id, divisionId: d.id, createdBy: "uji", status: "TERKIRIM", work: { panen: [{ name: "Oven Besar", v: [100, 0, 0, 200] }] } } });
    }
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-1`, physicalDate: new Date(`${year}-06-10T00:00:00Z`), tabung: 2, status: "DIPASANGKAN", transactionId: null, amount: 400000n, pricePerTabung: 200000n } });
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-2`, physicalDate: new Date(`${year}-06-12T00:00:00Z`), tabung: 1 } });
    const per = await biayaLpgPerPeriode(prisma, now);
    const bln = per[5];
    expect(bln.panen.bagus).toBe(shifts.length * 300);
    expect(bln.lpg.isiUlangDibayar).toBe(400000);
    expect(bln.lpg.estimasiMenunggu).toBe(200000);
    expect(bln.lpg.dipakai).toBe(600000);
    expect(bln.lpgPerPcs).toBe(Math.round((600000 / (shifts.length * 300)) * 100) / 100);
    expect(bln.lpg.catatan.join(" ")).toMatch(/belum dipasangkan/);
    expect(per[6].lpg.dipakai).toBe(600000);
  });

  it("gypsum 30 g × harga per gram", async () => {
    const g = await prisma.item.create({ data: { sku: `${tag}-GYP`, name: `Gypsum bubuk ${tag}`, unit: "sak", hppUnit: "gram", hppFactor: 18000, type: "BAHAN_BAKU", category: "Bahan Baku Utama", avgCost: 36000n, lastCost: 90000n } });
    created.items.push(g.id);
    const info = (await biayaGypsum(prisma)).find((x) => x.itemId === g.id)!;
    expect(info).toMatchObject({ sumber: "pembelian terakhir", perGram: 5, per30g: 150 });
  });

  it("--pasang: pratinjau tidak mengubah; resep cetak (30 g) + kering (1 cetak + overhead LPG); tidak menimpa; idempoten", async () => {
    const v = `U${tag}`;
    const cetak = await prisma.item.create({ data: { sku: `SJ-CTK-${v}`, name: `Patung cetak ${v}`, unit: "pcs", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" } });
    const kering = await prisma.item.create({ data: { sku: `SJ-PTG-${v}`, name: `Patung kering ${v}`, unit: "pcs", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" } });
    const manual = await prisma.item.create({ data: { sku: `SJ-PTG-M${tag}`, name: `Patung kering M${tag}`, unit: "pcs", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" } });
    created.items.push(cetak.id, kering.id, manual.id);
    const gyp = (await prisma.item.findFirstOrThrow({ where: { sku: `${tag}-GYP` } })).id;
    await prisma.itemRecipeLine.create({ data: { itemId: manual.id, componentId: gyp, qty: 7, useUnit: "gram" } }); // resep manual: tidak ditimpa
    const opts = { gypsumSku: `${tag}-GYP`, now };

    const prev = await pasangBiayaOven(prisma, false, opts);
    expect(prev.baris.join("\n")).toMatch(new RegExp(`SJ-CTK-${v}.*× 30 gram`));
    expect(prev.baris.join("\n")).toMatch(new RegExp(`SJ-PTG-M${tag}.*TIDAK diubah`));
    expect(await prisma.itemRecipeLine.count({ where: { itemId: cetak.id } })).toBe(0);

    await pasangBiayaOven(prisma, true, opts);
    const c = await prisma.itemRecipeLine.findFirstOrThrow({ where: { itemId: cetak.id } });
    expect([c.componentId, Number(c.qty), c.useUnit]).toEqual([gyp, 30, "gram"]);
    const k = await prisma.itemRecipeLine.findFirstOrThrow({ where: { itemId: kering.id } });
    expect([k.componentId, Number(k.qty)]).toEqual([cetak.id, 1]);
    const oh = await prisma.recipeOverhead.findFirstOrThrow({ where: { itemId: kering.id }, include: { overhead: true } });
    expect(oh.overhead.category).toBe("LPG");
    expect(Number((await prisma.itemRecipeLine.findFirstOrThrow({ where: { itemId: manual.id } })).qty)).toBe(7);
    const again = await rencanaPasang(prisma, opts);
    expect(again.aksi.filter((a) => "itemId" in a && [cetak.id, kering.id].includes(a.itemId))).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "PASANG_BIAYA_OVEN" } })).toBeGreaterThan(0);
  });
});

describe("perbaiki:resep-dobel", () => {
  it("hapus upah & overhead dobel di tahap berikutnya (persis temuan cek:resep-hpp), idempoten, temuan dobel jadi 0", async () => {
    const store = await prisma.store.findFirstOrThrow();
    const semi = await prisma.item.create({ data: { sku: `${tag}-SJ`, name: `Single Pack uji ${tag}`, unit: "pcs", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" } });
    created.items.push(semi.id);
    const task = await prisma.pieceTask.create({ data: { code: `${tag}T`, name: `Assembling uji ${tag}`, ratePerPcs: 60n } });
    const oh = await prisma.overhead.create({ data: { category: "Sewa Tempat", name: `Sewa uji ${tag}`, monthlyAmount: 1000000n, outputPerMonth: 1000 } });
    await prisma.recipeLabor.create({ data: { itemId: semi.id, taskId: task.id, name: "Assembling uji", rate: 60n } });
    await prisma.recipeOverhead.create({ data: { itemId: semi.id, overheadId: oh.id, factor: 1 } });
    const prod = await prisma.product.create({ data: { sku: `${tag}-P`, name: `Satuan uji ${tag}`, type: "SATUAN", variant: "CEWEK", storeId: store.id, bom: { create: [{ itemId: semi.id, qty: 1, useUnit: "pcs" }] } } });
    created.products.push(prod.id);
    const dobelL = await prisma.recipeLabor.create({ data: { productId: prod.id, taskId: task.id, name: "Assembling uji", rate: 60n } });
    const dobelO = await prisma.recipeOverhead.create({ data: { productId: prod.id, overheadId: oh.id, factor: 1 } });

    const prev = await rencanaResepDobel(prisma);
    expect(prev.map((r) => r.rowId)).toEqual(expect.arrayContaining([dobelL.id, dobelO.id]));
    await perbaikiResepDobel(prisma, false);
    expect(await prisma.recipeLabor.count({ where: { id: dobelL.id } })).toBe(1); // pratinjau tidak menghapus

    const audits0 = await prisma.auditLog.count({ where: { action: "RESEP_DOBEL_DIHAPUS" } });
    const done = await perbaikiResepDobel(prisma, true);
    expect(done.sisa).toBe(0);
    expect(await prisma.recipeLabor.count({ where: { id: dobelL.id } })).toBe(0);
    expect(await prisma.recipeOverhead.count({ where: { id: dobelO.id } })).toBe(0);
    expect(await prisma.recipeLabor.count({ where: { itemId: semi.id } })).toBe(1); // tahap sebelumnya tetap
    expect((await auditRecipes(prisma)).filter((f) => f.kind === "DOBEL_UPAH" || f.kind === "DOBEL_OVERHEAD")).toHaveLength(0);
    expect((await perbaikiResepDobel(prisma, true)).rows).toHaveLength(0); // idempoten
    expect(await prisma.auditLog.count({ where: { action: "RESEP_DOBEL_DIHAPUS" } })).toBe(audits0 + 1); // satu audit
  });
});
