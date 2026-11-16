import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { needsOrder } from "@/lib/shiftReport";
import { lowStockItems, needsReorder, recordMovement } from "@/lib/stock";
import { withCurrentLimits } from "@/lib/shiftReportStock";

const tag = `OL${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
let ids: { item: string; gudang: string; titikLoc: string; point: string };

describe("Stok = limit → order (semua jalur)", () => {
  it("rumus: menyentuh limit ikut order, toleransi desimal, limit 0 = tidak dipantau", () => {
    expect(needsOrder({ qty: 5, limit: 5 })).toBe(true);
    expect(needsOrder({ qty: 5.0000000001, limit: 5 })).toBe(true);
    expect(needsOrder({ qty: 5.1, limit: 5 })).toBe(false);
    expect(needsOrder({ qty: 0, limit: 0 })).toBe(false);
    expect(needsOrder({ qty: null, limit: 5 })).toBe(false);
    expect(needsReorder(5, 5)).toBe(true);
    expect(needsReorder(5 + 1e-12, 5)).toBe(true);
    expect(needsReorder(6, 5)).toBe(false);
  });

  beforeAll(async () => {
    const [g, t] = await Promise.all([
      prisma.location.create({ data: { code: `${tag}G`, name: `Gudang ${tag}` } }),
      prisma.location.create({ data: { code: `${tag}T`, name: `Titik ${tag}` } }),
    ]);
    const point = await prisma.boronganPoint.create({ data: { code: tag, name: `Titik ${tag}`, locationId: t.id } });
    const item = await prisma.item.create({ data: { sku: `${tag}-CK`, name: `Cat kuning ${tag}`, unit: "kg", hppUnit: "gram", hppFactor: 1000, type: "BAHAN_BAKU", minStock: 5 } });
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 15, toLocationId: g.id, unitCost: 1000, ref: `TES:${tag}` }, actor);
      // 10 kg dikirim ke titik borongan: stok gudang tinggal 5 = limit
      await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: 10, fromLocationId: g.id, toLocationId: t.id, ref: `TES:${tag}` }, actor);
    });
    ids = { item: item.id, gudang: g.id, titikLoc: t.id, point: point.id };
  });
  afterAll(async () => {
    await prisma.boronganPoint.update({ where: { id: ids.point }, data: { active: false } });
    await prisma.item.update({ where: { id: ids.item }, data: { active: false } });
  });

  it("stok menipis (Stok, lonceng, bot): dihitung dari stok gudang, bukan gudang + titik borongan", async () => {
    const low = await lowStockItems();
    const me = low.find((i) => i.id === ids.item);
    expect(me?.qty).toBe(5);
  });

  it("laporan lama menyimpan limit lama: batas TERKINI yang dipakai", async () => {
    const rows = await withCurrentLimits([{ itemId: ids.item, name: "x", unit: "kg", limit: 3, qty: 5 }]);
    expect(rows[0].limit).toBe(5);
    expect(rows.filter(needsOrder)).toHaveLength(1);
  });
});
