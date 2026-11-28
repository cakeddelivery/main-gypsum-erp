import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { koreksiDivisiHasil, planDivisiHasil, targetTemplate } from "@/lib/koreksiDivisiHasil";
import { resultItems } from "@/lib/shiftResultCount";

describe("targetTemplate", () => {
  it("SATUAN → Packing, GIFTBOX/induk Giftbox → Giftbox, lainnya tidak", () => {
    expect(targetTemplate({ type: "SATUAN" })).toBe("PACKING");
    expect(targetTemplate({ type: "GIFTBOX" })).toBe("GIFTBOX");
    expect(targetTemplate({ type: "CUSTOM", family: { name: "Giftbox Premium" } })).toBe("GIFTBOX");
    expect(targetTemplate({ type: "PAKET_12" })).toBeNull();
  });
});

describe("koreksi divisi hasil", () => {
  const made: { items: string[]; products: string[] } = { items: [], products: [] };
  let packing: string, giftbox: string, assembling: string, storeId: string;
  beforeAll(async () => {
    packing = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" }, orderBy: { name: "asc" } })).id;
    giftbox = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" }, orderBy: { name: "asc" } })).id;
    assembling = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" } })).id;
    storeId = (await prisma.store.findFirstOrThrow()).id;
  });
  afterAll(async () => {
    await prisma.product.updateMany({ where: { id: { in: made.products } }, data: { active: false, finishedItemId: null } });
    await prisma.item.updateMany({ where: { id: { in: made.items } }, data: { active: false } });
  });
  const run = Date.now().toString(36);
  const mk = async (tag: string, type: "SATUAN" | "GIFTBOX", divisionId: string | null) => {
    const item = await prisma.item.create({ data: { sku: `ZDH-${run}-${tag}`, name: `Uji ${tag}`, unit: "pcs", type: "BARANG_JADI", category: "Mainan Gypsum", divisionId } });
    const p = await prisma.product.create({ data: { sku: `ZDH-P-${run}-${tag}`, name: `Uji ${tag}`, type, variant: "CEWEK", storeId, finishedItemId: item.id } });
    made.items.push(item.id); made.products.push(p.id);
    return item.id;
  };

  it("pratinjau tidak mengubah; --jalankan memindahkan; barang muncul di resultItems divisinya", async () => {
    const sp = await mk("SP", "SATUAN", assembling);
    const gb = await mk("GB", "GIFTBOX", null);
    const ok = await mk("OK", "SATUAN", packing);
    expect((await resultItems(packing)).some((i) => i.id === sp)).toBe(false);

    const prev = await koreksiDivisiHasil(prisma, false);
    expect(prev.fixes.map((f) => f.id)).toEqual(expect.arrayContaining([sp, gb]));
    expect(prev.fixes.some((f) => f.id === ok)).toBe(false);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: sp } })).divisionId).toBe(assembling);

    await koreksiDivisiHasil(prisma, true);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: sp } })).divisionId).toBe(packing);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: gb } })).divisionId).toBe(giftbox);
    expect((await resultItems(packing)).some((i) => i.id === sp)).toBe(true);
    expect((await resultItems(giftbox)).some((i) => i.id === gb)).toBe(true);
    expect((await planDivisiHasil(prisma)).fixes.filter((f) => [sp, gb, ok].includes(f.id))).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "KOREKSI_DIVISI_HASIL" } })).toBeGreaterThan(0);
  });
});
