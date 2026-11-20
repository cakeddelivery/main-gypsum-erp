import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { alurProduksi, productionSummary, productionTrend } from "@/lib/alurProduksi";
import { dailyRecapText } from "@/lib/jobs";
import { summaryOf, type WorkData } from "@/lib/shiftReport";
import { FLOW_SETTING, CUTOVER_SETTING } from "@/lib/shiftReportFlow";
import { isAutoPostedItem, manualMovementGuard } from "@/lib/stock";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const DAY = "2034-05-10";

describe("Sumber produksi dari Laporan Shift (dashboard, rekap, bot, Alur Produksi)", () => {
  it("angka dashboard = rekap harian = Alur Produksi = ringkasan laporan; draf tidak dihitung", async () => {
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const mk = (code: string, template: string) => prisma.division.create({ data: { code: `${code}${tag}`, name: `Div ${code} ${tag}`, shiftCount: 1, reportTemplate: template } });
    const [dOven, dPack] = await Promise.all([mk("OV", "PRODUKSI"), mk("PK", "PACKING")]);
    const works: Record<string, WorkData> = {
      PRODUKSI: { panen: [{ name: "Oven Besar", v: [350, 100, 0, 50] }], reject: [{ name: "Oven Besar", v: [10, 0, 0, 5] }], cetakSeries: [{ name: "Cici", v: [40, 0, 0, 0] }] },
      PACKING: { resi: { shopee: 12, tiktok: 8 }, mix: { p12: 5, p24: 3 }, satuan: { cowok: 20 } },
    };
    const date = new Date(`${DAY}T00:00:00Z`);
    const [rO, rP] = await Promise.all([
      prisma.shiftReport.create({ data: { date, shiftId: shift.id, divisionId: dOven.id, createdBy: "t", status: "TERKIRIM", work: works.PRODUKSI } }),
      prisma.shiftReport.create({ data: { date, shiftId: shift.id, divisionId: dPack.id, createdBy: "t", status: "TERKIRIM", work: works.PACKING } }),
    ]);
    try {
      const alur = await alurProduksi({ date: DAY });
      const sum = await productionSummary(DAY);
      const oven = summaryOf("PRODUKSI", works.PRODUKSI);
      const pack = summaryOf("PACKING", works.PACKING);
      // Dashboard/ringkasan bot (productionSummary) = Alur Produksi = ringkasan laporan
      expect(sum.boxes.map((b) => [b.key, b.good, b.reject])).toEqual(alur.map((b) => [b.key, b.good, b.reject]));
      expect(alur.find((b) => b.key === "OVEN")!.good).toBe(oven.find((s) => s.label === "Total panen")!.value);
      expect(alur.find((b) => b.key === "PACKING")!.good).toBe(pack.find((s) => s.label === "Total patung")!.value);
      expect(sum.good).toBe(500);
      expect(sum.reject).toBe(15); // reject panen
      // Rekap Telegram memuat angka yang sama
      const txt = await dailyRecapText(new Date(`${DAY}T10:00:00Z`), DAY);
      expect(txt).toContain(`Oven: ${alur.find((b) => b.key === "OVEN")!.good.toLocaleString("id-ID")} pcs`);
      expect(txt).toContain(`Packing: ${alur.find((b) => b.key === "PACKING")!.good.toLocaleString("id-ID")} pcs`);
      // Tren grafik dashboard
      const trend = await productionTrend(3, {});
      expect(trend).toHaveLength(3);
      // Draf tidak dihitung; filter divisi
      await prisma.shiftReport.update({ where: { id: rP.id }, data: { status: "DRAFT" } });
      expect((await productionSummary(DAY)).boxes.find((b) => b.key === "PACKING")!.good).toBe(0);
      expect((await productionSummary(DAY, { divisionId: dPack.id })).boxes.find((b) => b.key === "OVEN")!.good).toBe(0);
    } finally {
      await prisma.shiftReport.deleteMany({ where: { id: { in: [rO.id, rP.id] } } });
      await prisma.division.deleteMany({ where: { id: { in: [dOven.id, dPack.id] } } });
    }
  });
});

describe("Stok › Mutasi: barang otomatis setelah cut-over", () => {
  it("jenis barang otomatis", () => {
    expect(isAutoPostedItem({ sku: "SJ-PTG-HEWAN", type: "BARANG_DALAM_PROSES" })).toBe(true);
    expect(isAutoPostedItem({ sku: "SJ-CTK-COWOK", type: "BARANG_DALAM_PROSES" })).toBe(true);
    expect(isAutoPostedItem({ sku: "BJ-X", type: "BARANG_JADI" })).toBe(true);
    expect(isAutoPostedItem({ sku: "BB-GYPSUM", type: "BAHAN_BAKU" })).toBe(false);
  });

  it("non-Owner ditolak; Owner wajib alasan & berlabel koreksi; sebelum tanggal cut-over / sakelar mati tetap boleh", async () => {
    const prevFlow = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value;
    const prevCut = (await prisma.setting.findUnique({ where: { key: CUTOVER_SETTING } }))?.value;
    const set = (key: string, value: string) => prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    const auto = await prisma.item.create({ data: { sku: `SJ-PTG-UJI${tag}`, name: `Patung kering uji ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs" } });
    const bahan = await prisma.item.create({ data: { sku: `BB-UJI${tag}`, name: `Bahan uji ${tag}`, type: "BAHAN_BAKU", unit: "kg" } });
    const base = { type: "PENGELUARAN" as const, fromLocationId: null, toLocationId: null };
    try {
      await set(FLOW_SETTING, "true");
      await set(CUTOVER_SETTING, "2026-12-01");
      const after = "2026-12-02";
      await expect(manualMovementGuard({ ...base, role: "ADMIN", reason: "uji", itemId: auto.id, date: after })).rejects.toThrow(/diposting otomatis/);
      await expect(manualMovementGuard({ ...base, role: "OWNER", reason: "", itemId: auto.id, date: after })).rejects.toThrow(/wajib alasan/);
      expect(await manualMovementGuard({ ...base, role: "OWNER", reason: "Koreksi hitung fisik", itemId: auto.id, date: after })).toEqual({ correction: true });
      // sebelum tanggal cut-over: aturan lama
      expect(await manualMovementGuard({ ...base, role: "ADMIN", reason: null, itemId: auto.id, date: "2026-11-20" })).toEqual({ correction: false });
      // bahan baku tidak terpengaruh
      expect(await manualMovementGuard({ ...base, role: "ADMIN", reason: null, itemId: bahan.id, date: after })).toEqual({ correction: false });
      // sakelar mati
      await set(FLOW_SETTING, "false");
      expect(await manualMovementGuard({ ...base, role: "ADMIN", reason: null, itemId: auto.id, date: after })).toEqual({ correction: false });
    } finally {
      if (prevFlow === undefined) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
      else await set(FLOW_SETTING, prevFlow);
      if (prevCut === undefined) await prisma.setting.deleteMany({ where: { key: CUTOVER_SETTING } });
      else await set(CUTOVER_SETTING, prevCut);
      await prisma.item.deleteMany({ where: { id: { in: [auto.id, bahan.id] } } });
    }
  });
});
