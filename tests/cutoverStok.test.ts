import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CUTOVER_SETTING, FLOW_SETTING, cutoverDate, flowEnabledOn, postShiftWork } from "@/lib/shiftReportFlow";
import { applyResultCount } from "@/lib/shiftResultCount";
import { cutoverReadiness, countList } from "@/lib/cutover";
import { recordProductionEntry } from "@/lib/productionEntry";

describe("Cut-over stok terpadu (tanggal mulai)", () => {
  let prevT: string | null | undefined;
  let prevF: string | null | undefined;
  afterAll(async () => {
    const restore = async (key: string, v: string | null | undefined) => {
      if (v === undefined) return;
      if (v === null) await prisma.setting.deleteMany({ where: { key } });
      else await prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
    };
    await restore(CUTOVER_SETTING, prevT);
    await restore(FLOW_SETTING, prevF);
  });
  const set = (key: string, value: string) => prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

  it("flowEnabledOn: sakelar mati = tidak; tanggal sebelum mulai = tidak; mulai & sesudahnya = ya; tanpa tanggal mulai = ya", async () => {
    prevT = (await prisma.setting.findUnique({ where: { key: CUTOVER_SETTING } }))?.value ?? null;
    prevF = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
    await set(FLOW_SETTING, "false");
    await set(CUTOVER_SETTING, "2026-12-01");
    expect(await flowEnabledOn("2026-12-05")).toBe(false);
    await set(FLOW_SETTING, "true");
    expect(await cutoverDate()).toBe("2026-12-01");
    expect([await flowEnabledOn("2026-11-30"), await flowEnabledOn("2026-12-01"), await flowEnabledOn(new Date("2026-12-09T00:00:00Z"))]).toEqual([false, true, true]);
    await prisma.setting.delete({ where: { key: CUTOVER_SETTING } });
    expect(await flowEnabledOn("2020-01-01")).toBe(true);
  });

  it("laporan bertanggal sebelum tanggal mulai tidak diposting; Produksi manual terkunci untuk non-Owner setelah mulai", async () => {
    await set(FLOW_SETTING, "true");
    await set(CUTOVER_SETTING, "2999-01-01"); // masa depan: semua laporan lama dilewati
    const div = await prisma.division.create({ data: { code: `CO${Date.now().toString(36).slice(-5).toUpperCase()}`, name: "Cetak Cutover", shiftCount: 1, reportTemplate: "CETAK" } });
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const rep = await prisma.shiftReport.create({ data: { date: new Date("2026-11-20T00:00:00Z"), shiftId: shift.id, divisionId: div.id, createdBy: "t", status: "TERKIRIM", work: { cetakSeries: [{ name: "A", v: [10, 0, 0, 0] }] } } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    expect(await postShiftWork(rep.id, { id: owner.id, name: owner.name })).toEqual({ posted: 0, skipped: "sebelum tanggal mulai stok terpadu" });
    expect(await applyResultCount(rep.id, { id: owner.id, name: owner.name })).toEqual({ adjusted: 0, skipped: "sebelum tanggal mulai stok terpadu" });

    // Setelah tanggal mulai (tanggal lampau): semua tahap manual terkunci untuk non-Owner
    await set(CUTOVER_SETTING, "2020-01-01");
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: "AKTIF" } });
    const nonOwner = { id: "x", name: "Admin", role: "ADMIN", divisionId: null, employeeId: null } as never;
    await expect(recordProductionEntry({ date: "2026-11-20", stage: "CETAK", employeeId: emp.id, divisionId: div.id, shiftId: shift.id, productId: (await prisma.product.findFirstOrThrow()).id, qtyGood: 5, qtyReject: 0, rejectReason: null } as never, nonOwner)).rejects.toThrow(/Laporan Shift/);
  });

  it("kesiapan & daftar hitung stok awal", async () => {
    const r = await cutoverReadiness();
    expect(r.checks.map((c) => c.key)).toEqual(["tanggal", "opname", "divisi", "minus", "draf", "bmk", "lpg", "tabel", "sakelar"]);
    const list = await countList();
    expect(list.length).toBeGreaterThan(0);
    expect(Object.keys(list[0]).sort()).toEqual(["division", "name", "sku", "system", "type", "unit"]);
  });
});
