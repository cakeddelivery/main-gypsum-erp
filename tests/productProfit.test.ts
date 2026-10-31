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

  it("laba = jadi × laba/pcs harga resep, dikurangi reject × bahan/pcs", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { active: true } });
    const [shift, division, employee] = await Promise.all([prisma.shift.findFirstOrThrow(), prisma.division.findFirstOrThrow(), prisma.employee.findFirstOrThrow()]);
    const date = new Date("2031-03-10T00:00:00.000Z");
    await prisma.priceHistory.create({ data: { productId: product.id, channel: "OFFLINE", price: BigInt(50000), hpp: BigInt(0), effectiveAt: new Date("2031-03-01"), createdBy: "test" } });
    const base = { date, shiftId: shift.id, divisionId: division.id, employeeId: employee.id, productId: product.id, createdBy: "test", stockPosted: true };
    await prisma.productionEntry.createMany({
      data: [
        { ...base, stage: "CETAK", qtyGood: 100, qtyReject: 4, rejectReason: "Pecah / retak" },
        { ...base, stage: "BARANG_JADI", qtyGood: 90, qtyReject: 1, rejectReason: "Kotor / noda" },
      ],
    });
    const range = { start: new Date("2031-03-01T00:00:00Z"), end: new Date("2031-04-01T00:00:00Z") };
    const { rows } = await productProfit(range, "OFFLINE");
    const r = rows.find((x) => x.productId === product.id)!;
    expect(r.qtyDone).toBe(90);
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
    expect(rj.reason).toEqual([{ label: "Pecah / retak", reject: 4 }, { label: "Kotor / noda", reject: 1 }]);
    expect(rj.stage.map((s) => s.stage)).toEqual(["CETAK", "BARANG_JADI"]);
  });
});
