import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createInvoice, invoiceFromSale, invoiceNumber, invoiceStatus, invoiceTotals, voidInvoice, yymmOf } from "@/lib/invoice";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const actor = { id: "t", name: "Tester" };

describe("Invoice: bagian murni", () => {
  it("nomor INV/{toko}/{channel}/{YYMM}/{urut 4 digit}", () => {
    expect(invoiceNumber("MG", "TTS", "2611", 42)).toBe("INV/MG/TTS/2611/0042");
    expect(invoiceNumber("DL", "OFF", "2701", 1)).toBe("INV/DL/OFF/2701/0001");
    expect(yymmOf("2026-11-19")).toBe("2611");
  });
  it("total = jumlah − diskon + ongkir; isian salah ditolak", () => {
    expect(invoiceTotals([{ qty: 2, price: 39360 }, { qty: 1, price: 45000 }], 5000, 10000)).toEqual({ subtotal: 123720, total: 128720 });
    expect(() => invoiceTotals([])).toThrow(/minimal satu/);
    expect(() => invoiceTotals([{ qty: 0, price: 1 }])).toThrow(/lebih dari 0/);
    expect(() => invoiceTotals([{ qty: 1, price: 1000 }], 2000)).toThrow(/Diskon melebihi/);
  });
  it("status lunas mengikuti pembayaran; batal", () => {
    const base = { total: BigInt(1000), paid: BigInt(0), cancelledAt: null };
    expect(invoiceStatus(base).key).toBe("BELUM");
    expect(invoiceStatus(base, BigInt(1000)).lunas).toBe(true);
    expect(invoiceStatus({ ...base, paid: BigInt(1000) }).lunas).toBe(true);
    expect(invoiceStatus({ ...base, cancelledAt: new Date() }).key).toBe("BATAL");
  });
});

describe("Invoice: database", () => {
  async function setup() {
    const org = await prisma.organization.findFirstOrThrow();
    const store = (await prisma.store.findUnique({ where: { code: "MG" } })) ?? (await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } }));
    const item = await prisma.item.create({ data: { sku: `INV-${tag}-${Math.random().toString(36).slice(2, 6)}`, name: `Paket Uji ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: (await prisma.division.findFirstOrThrow()).id } });
    return { store, item };
  }

  it("nomor unik & berurutan walau dibuat bersamaan; per channel/bulan terpisah; batal tidak memakai ulang nomor", async () => {
    const { store, item } = await setup();
    const mk = (ch: string, date = "2032-03-10") => createInvoice(actor, { storeId: store.id, channel: ch, date, customerName: "Toko Contoh", lines: [{ itemId: item.id, qty: 2, price: 39360 }], paid: 78720 });
    const batch = await Promise.all([mk("TTS"), mk("TTS"), mk("TTS"), mk("TTS"), mk("SHP"), mk("TTS", "2032-04-02")]);
    const tts = batch.filter((b) => b.channel === "TTS" && b.yymm === "3203").map((b) => b.seq).sort((a, b) => a - b);
    expect(tts).toEqual([1, 2, 3, 4]);
    expect(batch.find((b) => b.channel === "SHP")!.number).toBe("INV/MG/SHP/3203/0001");
    expect(batch.find((b) => b.yymm === "3204")!.number).toBe("INV/MG/TTS/3204/0001");
    expect(new Set(batch.map((b) => b.number)).size).toBe(batch.length);
    await voidInvoice(actor, batch[0].id, "salah input");
    const next = await mk("TTS");
    expect(next.seq).toBe(5); // nomor yang dibatalkan tidak dipakai ulang
    await expect(voidInvoice(actor, batch[0].id, "lagi")).rejects.toThrow(/sudah dibatalkan/);
  });

  it("validasi: toko tanpa kode invoice, channel, nama pembeli", async () => {
    const { store, item } = await setup();
    const org = await prisma.organization.findFirstOrThrow();
    const other = await prisma.store.create({ data: { code: `X${tag}`, name: "Toko Lain", organizationId: org.id } });
    const base = { date: "2032-03-10", customerName: "Budi", lines: [{ itemId: item.id, qty: 1, price: 1000 }] };
    await expect(createInvoice(actor, { ...base, storeId: other.id, channel: "TTS" })).rejects.toThrow(/belum punya kode invoice/);
    await expect(createInvoice(actor, { ...base, storeId: store.id, channel: "TOKPED" })).rejects.toThrow(/channel/i);
    await expect(createInvoice(actor, { ...base, storeId: store.id, channel: "OFF", customerName: " " })).rejects.toThrow(/Nama pembeli/);
  });

  it("dari penjualan offline: satu invoice per penjualan (channel OFF), status mengikuti pembayaran", async () => {
    const { store, item } = await setup();
    const sale = await prisma.sale.create({
      data: { number: `JUAL-TEST-${tag}`, date: new Date("2032-03-10T03:00:00Z"), storeId: store.id, customerName: "Pelanggan X", subtotal: BigInt(100000), total: BigInt(100000), paid: BigInt(0), createdBy: "t", lines: { create: [{ itemId: item.id, qty: 2, price: BigInt(50000), amount: BigInt(100000) }] } },
    });
    const a = await invoiceFromSale(actor, sale.id);
    const b = await invoiceFromSale(actor, sale.id);
    expect(b.id).toBe(a.id);
    expect(a.channel).toBe("OFF");
    expect(a.number).toMatch(/^INV\/MG\/OFF\/3203\/\d{4}$/);
    expect(invoiceStatus(a).lunas).toBe(false);
    expect(invoiceStatus(a, BigInt(100000)).lunas).toBe(true); // dibayar belakangan → lunas
  });
});
