import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { doneQty, productProfit, rate, rejectBreakdown } from "@/lib/productProfit";
import { toCsv, csvCell } from "@/lib/csv";

describe("CSV export", () => {
  it("pemisah titik koma, BOM, angka desimal koma, kutip bila perlu", () => {
    const s = toCsv([["Nama", "Jumlah"], ["Gypsum; sak", 1.5], ['Kata "kutip"', -2000]]);
    expect(s.startsWith("﻿")).toBe(true);
    expect(s).toContain('"Gypsum; sak";1,5');
    expect(s).toContain('"Kata ""kutip""";-2000');
  });
  it("cegah formula injection di teks", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5 pcs")).toBe("-5 pcs");
  });
});

describe("Laba & reject per produk", () => {
  it("jumlah jadi diambil dari tahap paling akhir yang tercatat", () => {
    expect(doneQty(new Map([["CETAK", 100], ["PACKING", 80]]))).toEqual({ stage: "PACKING", qty: 80 });
    expect(doneQty(new Map([["CETAK", 100], ["BARANG_JADI", 70], ["PACKING", 90]]))).toEqual({ stage: "BARANG_JADI", qty: 70 });
    expect(rate(5, 95)).toBe(5);
    expect(rate(0, 0)).toBe(0);
  });

  it("laba = jadi × laba/pcs harga resep, dikurangi reject × bahan/pcs — dari Laporan Shift (katalog) + Reject produksi", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { active: true, finishedItemId: { not: null } } });
    const shift = await prisma.shift.findFirstOrThrow();
    const division = await prisma.division.create({ data: { code: `PL${Date.now().toString(36).slice(-5).toUpperCase()}`, name: `Packing Laba ${Date.now()}`, shiftCount: 1, reportTemplate: "PACKING" } });
    await prisma.priceHistory.create({ data: { productId: product.id, channel: "OFFLINE", price: BigInt(50000), hpp: BigInt(0), effectiveAt: new Date("2031-03-01"), createdBy: "test" } });
    const line = (qty: number) => ({ productId: product.id, sku: product.sku, label: "x", col: "x", variant: "Mix", patung: 1, qty });
    const rep = await prisma.shiftReport.create({ data: { date: new Date("2036-07-10T00:00:00.000Z"), shiftId: shift.id, divisionId: division.id, createdBy: "t", status: "TERKIRIM", work: { st: [line(90)] } } });
    const draft = await prisma.shiftReport.create({ data: { date: new Date("2036-07-11T00:00:00.000Z"), shiftId: shift.id, divisionId: division.id, createdBy: "t", status: "DRAFT", work: { st: [line(999)] } } });
    await prisma.productionReject.createMany({ data: [
      { reportId: rep.id, divisionId: division.id, stage: "CETAK", itemId: product.finishedItemId!, qty: 4, reason: "RETAK", createdBy: "t" },
      { reportId: rep.id, divisionId: division.id, stage: "PACKING", itemId: product.finishedItemId!, qty: 1, reason: "CACAT_CAT", createdBy: "t" },
    ] });
    try {
      const range = { start: new Date("2036-07-01T00:00:00Z"), end: new Date("2036-08-01T00:00:00Z") };
      const { rows } = await productProfit(range, "OFFLINE");
      const r = rows.find((x) => x.productId === product.id)!;
      expect(r.qtyDone).toBe(90); // draf (999) tidak dihitung
      expect(r.qtyReject).toBe(5);
      expect(r.price).toBe(50000);
      expect(r.profitUnit).toBe(50000 - r.hpp);
      expect(r.profit).toBe((50000 - r.hpp) * 90);
      expect(r.rejectLoss).toBe(r.materialUnit * 5);
      expect(r.net).toBe(r.profit! - r.rejectLoss);
      // Produk tanpa harga di kanal terpilih: laba kosong (bukan 0) supaya tidak menyesatkan
      await prisma.priceHistory.deleteMany({ where: { productId: product.id, channel: "RESELLER" } });
      const res = (await productProfit(range, "RESELLER")).rows.find((x) => x.productId === product.id)!;
      expect(res.price).toBeNull();
      expect(res.net).toBeNull();
      expect(res.rejectLoss).toBe(r.rejectLoss);
      const rj = await rejectBreakdown(range);
      expect(rj.reason).toEqual([{ label: "Reject RETAK", reject: 4 }, { label: "Reject CACAT_CAT", reject: 1 }].map((x) => ({ label: x.label.replace("Reject ", ""), reject: x.reject })));
      expect(rj.stage.filter((s) => ["CETAK", "PACKING"].includes(s.stage)).map((s) => s.stage)).toEqual(["CETAK", "PACKING"]);
      expect(rj.stage.find((s) => s.stage === "PACKING")).toMatchObject({ good: 90, reject: 1 });
      expect(rj.division.find((d) => d.label === division.name)).toMatchObject({ reject: 5 });
    } finally {
      await prisma.productionReject.deleteMany({ where: { reportId: rep.id } });
      await prisma.shiftReport.deleteMany({ where: { id: { in: [rep.id, draft.id] } } });
      await prisma.division.delete({ where: { id: division.id } });
    }
  });
});
