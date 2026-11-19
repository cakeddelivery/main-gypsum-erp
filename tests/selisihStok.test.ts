import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, recordMovement } from "@/lib/stock";
import { stockGapReport } from "@/lib/stockGap";
import { addDays, jakartaDateTime, todayStr } from "@/lib/time";

describe("Selisih stok vs laporan shift (hanya membaca)", () => {
  it("menampilkan selisih hitungan laporan vs stok aplikasi + mutasi per jenis; tidak mengubah data", async () => {
    const tag = Date.now().toString(36).slice(-5).toUpperCase();
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: u.id, name: u.name };
    const day = addDays(todayStr(), -1);
    const when = jakartaDateTime(day, "07:00");
    const { wip } = await locationSettings(prisma);
    const div = await prisma.division.create({ data: { code: `SG${tag}`, name: `Oven Sel ${tag}`, shiftCount: 2, reportTemplate: "PRODUKSI" } });
    const item = await prisma.item.create({ data: { sku: `SG-${tag}`, name: `Patung kering ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs", divisionId: div.id } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 3000, toLocationId: wip!, unitCost: 100, ref: `PRD:${tag}`, date: when }, actor));
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: item.id, qty: 1000, fromLocationId: wip!, ref: `KRM:${tag}`, date: when, allowNegative: true }, actor));
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    await prisma.shiftReport.create({ data: { date: new Date(`${day}T00:00:00Z`), shiftId: shift.id, divisionId: div.id, status: "TERKIRIM", createdBy: "t", work: { _hasil: { [item.id]: 2000 } } } });

    const before = await prisma.stockMovement.count();
    const r = await stockGapReport(14);
    const row = r.rows.find((x) => x.itemId === item.id);
    expect(row).toBeTruthy();
    expect([row!.counted, row!.system]).toEqual([2000, 2000]);
    expect(row!.diff).toBe(0);
    const kinds = r.flows.filter((x) => x.itemId === item.id).map((x) => [x.kind, x.masukWip, x.keluarWip]);
    expect(kinds).toEqual(expect.arrayContaining([["KRM", 0, 1000], ["PRD", 3000, 0]]));
    expect(typeof r.settingOn).toBe("boolean");
    expect(await prisma.stockMovement.count()).toBe(before);
  });
});
