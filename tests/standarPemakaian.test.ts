import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, recordMovement } from "@/lib/stock";
import { STD_GYPSUM, actualUsage, expectedUsage, listStandards, median, refreshStandards, robustMedian, setStandard, unmonitoredItems, usageCheck } from "@/lib/usageStandard";
import { addDays, dateOnly, jakartaDateTime, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();

describe("Standar pemakaian", () => {
  it("median & median tahan pencilan", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(robustMedian([10, 10, 11, 10, 12, 10, 500])).toBeCloseTo(10, 0); // 500 dibuang
  });

  it("standar proses: otomatis belum cukup data; Owner menetapkan manual lalu kembali otomatis", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    expect((await refreshStandards()).every((r) => r.value == null || typeof r.value === "number")).toBe(true);
    let g = (await listStandards()).find((x) => x.key === STD_GYPSUM)!;
    expect([g.mode, g.effective === null || g.auto === g.effective]).toEqual(["AUTO", true]);
    await expect(setStandard(STD_GYPSUM, { mode: "MANUAL", value: 0 }, u)).rejects.toThrow(/lebih dari 0/);
    await setStandard(STD_GYPSUM, { mode: "MANUAL", value: 420 }, u);
    g = (await listStandards()).find((x) => x.key === STD_GYPSUM)!;
    expect([g.mode, g.effective, g.manual]).toEqual(["MANUAL", 420, 420]);
    await setStandard(STD_GYPSUM, { mode: "AUTO" }, u);
    g = (await listStandards()).find((x) => x.key === STD_GYPSUM)!;
    expect([g.mode, g.manual]).toEqual(["AUTO", null]);
  });

  it("bahan pendukung: standar = resep × hasil; aktual dari opname; lebih dari 15% ditandai", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: u.id, name: u.name };
    const { raw } = await locationSettings(prisma);
    const div = await prisma.division.create({ data: { code: `SP${tag}`, name: `Cetak Std ${tag}`, shiftCount: 1, reportTemplate: "CETAK" } });
    const gypsum = await prisma.item.create({ data: { sku: `SP-G-${tag}`, name: `Gypsum ${tag}`, type: "BAHAN_BAKU", unit: "sak", hppUnit: "gram", hppFactor: 18000, avgCost: 100000, divisionId: div.id } });
    const basah = (await prisma.item.findUnique({ where: { sku: "SJ-CTK-HEWAN" } })) ?? (await prisma.item.create({ data: { sku: "SJ-CTK-HEWAN", name: "Patung cetak Hewan", type: "BARANG_DALAM_PROSES", unit: "pcs" } }));
    // 3.000 gram gypsum per patung basah → 3000/18000 sak
    await prisma.itemRecipeLine.upsert({ where: { itemId_componentId: { itemId: basah.id, componentId: gypsum.id } }, create: { itemId: basah.id, componentId: gypsum.id, qty: 3000 }, update: { qty: 3000 } });
    const day = addDays(todayStr(), -2);
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: div.id, status: "TERKIRIM", createdBy: "t", work: { cetakSeries: [{ name: "A", v: [12, 0, 0, 0] }] } } });
    const exp = await expectedUsage(rep.id);
    expect(exp.get(gypsum.id)).toBeCloseTo(2, 3); // 12 × 3000 / 18000

    // Aktual 2,5 sak (opname: pemakaian) → +25% → ditandai
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENYESUAIAN", itemId: gypsum.id, qty: 2.5, fromLocationId: raw!, increase: false, usage: true, allowNegative: true, ref: `LAP:${rep.id}`, date: jakartaDateTime(day, "12:00") }, actor));
    expect((await actualUsage(rep.id)).get(gypsum.id)).toBe(2.5);
    const rows = await usageCheck(rep.id);
    const row = rows.find((x) => x.itemId === gypsum.id)!;
    expect([row.standard, row.actual, row.overPct, row.over]).toEqual([2, 2.5, 25, true]);
    expect(row.valueOver).toBe(50000);
    // Dalam toleransi (2,2 sak = +10%) tidak ditandai
    await prisma.stockMovement.deleteMany({ where: { ref: `LAP:${rep.id}` } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENYESUAIAN", itemId: gypsum.id, qty: 2.2, fromLocationId: raw!, increase: false, usage: true, allowNegative: true, ref: `LAP:${rep.id}`, date: jakartaDateTime(day, "12:00") }, actor));
    expect((await usageCheck(rep.id)).find((x) => x.itemId === gypsum.id)!.over).toBe(false);
    // Belum terpantau: bahan baru tanpa hitungan di laporan 30 hari
    expect((await unmonitoredItems()).some((x) => x.id === gypsum.id && x.reason === "TIDAK_DIHITUNG")).toBe(true);
  });
});
