import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, recordMovement } from "@/lib/stock";
import { boronganBalanceLines, classifyMovement, computeShiftBalance, saveShiftBalance } from "@/lib/shiftBalance";
import { addDays, dateOnly, jakartaDateTime, todayStr } from "@/lib/time";

const L = "loc1", OTHER = "loc2";
const mv = (type: string, ref: string | null, from: string | null, to: string | null) => ({ type, ref, fromLocationId: from, toLocationId: to });

describe("Neraca stok per shift", () => {
  it("penggolongan mutasi: produksi, masuk, borongan, pakai, jual, reject; penyesuaian laporan ini dikecualikan", () => {
    const c = (m: ReturnType<typeof mv>) => classifyMovement(m, L, "R1");
    expect(c(mv("HASIL_PRODUKSI", "LPH:R9:1", null, L))).toEqual({ dir: "in", kind: "produksi" });
    expect(c(mv("PENERIMAAN", "PBL-1", null, L))).toEqual({ dir: "in", kind: "masuk" });
    expect(c(mv("TRANSFER", "PND:AMB-1", OTHER, L))).toEqual({ dir: "in", kind: "borongan" });
    expect(c(mv("TRANSFER", "KRM:KRM-1", L, OTHER))).toEqual({ dir: "out", kind: "borongan" });
    expect(c(mv("KONSUMSI_PRODUKSI", "LPH:R9:1", L, null))).toEqual({ dir: "out", kind: "pakai" });
    expect(c(mv("PENGELUARAN", "JUAL-1", L, null))).toEqual({ dir: "out", kind: "jual" });
    expect(c(mv("PENYESUAIAN", "RJK:R9:abc", L, null))).toEqual({ dir: "out", kind: "reject" });
    expect(c(mv("PENYESUAIAN", "LPS:R1", L, null))).toBeNull(); // selisih laporan ini sendiri
    expect(c(mv("PENYESUAIAN", "LPS:R2", L, null))).toEqual({ dir: "out", kind: "lain" });
    expect(c(mv("TRANSFER", "X", OTHER, "loc3"))).toBeNull();
  });

  it("di database: awal + produksi − KRM = sistem; selisih terhadap hitung fisik; snapshot tersimpan & diganti saat revisi", async () => {
    const tag = Date.now().toString(36).slice(-5).toUpperCase();
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: u.id, name: u.name };
    const { wip } = await locationSettings(prisma);
    const other = (await prisma.location.findFirst({ where: { id: { not: wip! } } }))!;
    const day = addDays(todayStr(), -3);
    const div = await prisma.division.create({ data: { code: `NR${tag}`, name: `Oven Neraca ${tag}`, shiftCount: 1, reportTemplate: "PRODUKSI" } });
    const item = await prisma.item.create({ data: { sku: `NR-${tag}`, name: `Patung kering ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs", divisionId: div.id } });
    const at = (h: string) => jakartaDateTime(day, h);
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 1000, toLocationId: wip!, unitCost: 100, ref: `AWAL-${tag}`, date: at("01:00") }, actor);
      await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 3000, toLocationId: wip!, unitCost: 100, ref: `LPH:X${tag}:1`, date: at("10:00") }, actor);
      await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: 2000, fromLocationId: wip!, toLocationId: other.id, ref: `KRM:KRM-${tag}`, date: at("11:00") }, actor);
    });
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: div.id, status: "TERKIRIM", createdBy: "t", picName: "oven", work: { _hasil: { [item.id]: 1900 } } } });

    const rows = await computeShiftBalance(rep.id);
    const x = rows.find((y) => y.itemId === item.id)!;
    expect([x.opening, x.produksi, x.outBorongan, x.systemClosing, x.counted, x.diff]).toEqual([1000, 3000, 2000, 2000, 1900, -100]);
    expect(boronganBalanceLines(rows).join("|")).toContain("keluar ke borongan 2.000");

    await saveShiftBalance(rep.id);
    const saved = await prisma.shiftBalance.findUniqueOrThrow({ where: { reportId_itemId: { reportId: rep.id, itemId: item.id } } });
    expect([Number(saved.systemClosing), Number(saved.diff), saved.picName]).toEqual([2000, -100, "oven"]);
    // revisi hitungan → snapshot diganti
    await prisma.shiftReport.update({ where: { id: rep.id }, data: { work: { _hasil: { [item.id]: 2000 } } } });
    await saveShiftBalance(rep.id);
    expect(await prisma.shiftBalance.count({ where: { reportId: rep.id } })).toBe(1);
    expect(Number((await prisma.shiftBalance.findFirstOrThrow({ where: { reportId: rep.id } })).diff)).toBe(0);
  });
});
