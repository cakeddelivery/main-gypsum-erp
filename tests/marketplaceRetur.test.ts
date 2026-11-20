import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedOrder } from "@/lib/marketplace/parse";
import { courierGuess, lookupOrderById, lookupOrders, queryTokens, unloggedCounts } from "@/lib/marketplace/lookup";
import { createReturn } from "@/lib/returns";
import { createComplaint } from "@/lib/complaints";
import { StockError } from "@/lib/stock";

const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

const order = (orderNo: string, o: Partial<ParsedOrder>): ParsedOrder => ({ orderNo, orderedAt: new Date("2036-04-01T03:00:00Z"), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: "SPX Standard", courier: "SPX", paymentMethod: null, city: "KAB. LAMONGAN", province: "JAWA TIMUR", creatorHandle: null, affiliate: false, subtotal: 0, discount: 0, shippingPaid: 0, total: 50000, refundAmount: 0, returnQty: 0, lines: [{ sku: `RTSKU${tag}`, variation: null, name: "Paket Uji", qty: 2, unitPrice: 25000, amount: 50000, returnQty: 0 }], ...o });
const file = (orders: ParsedOrder[]): ParsedFile => ({ platform: "SHOPEE", kind: "ORDER", orders, incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 } });

let cached: Awaited<ReturnType<typeof setupOnce>> | null = null;
const setup = async () => (cached ??= await setupOnce());
async function setupOnce() {
  const org = await prisma.organization.findFirstOrThrow();
  const st = (await prisma.store.findUnique({ where: { code: "MG" } })) ?? (await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } }));
  const div = await prisma.division.findFirstOrThrow();
  const item = await prisma.item.create({ data: { sku: `RT-${tag}`, name: `Produk Retur ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: div.id } });
  cleanups.push(() => prisma.item.delete({ where: { id: item.id } }));
  await prisma.marketplaceSkuMap.create({ data: { key: `RTSKU${tag}|`, itemId: item.id, updatedBy: "t" } });
  cleanups.push(() => prisma.marketplaceSkuMap.deleteMany({ where: { key: `RTSKU${tag}|` } }));
  return { st, item };
}

describe("Retur/Komplain ↔ pesanan marketplace", () => {
  it("kode dari scan/ketik: token dari QR/URL; tebak kurir dari opsi kirim", () => {
    expect(queryTokens("https://x.id/o?no=2604ABCD1234&x=1")).toContain("2604ABCD1234");
    expect(queryTokens(" spxid 123456 789 ")).toContain("SPXID123456789");
    expect(courierGuess("SPX Standard")).toBe("SPX");
    expect(courierGuess("J&T Express")).toBe("J&T");
    expect(courierGuess("J&T Cargo")).toBe("J&T Cargo");
    expect(courierGuess(null)).toBeNull();
  });

  it("cari lewat No. Pesanan ATAU No. Resi; hasil memuat toko, kanal, resi, kota/provinsi, produk (sudah dipetakan) & qty", async () => {
    const { st, item } = await setup();
    const no = `261${num}A${tag}`, resi = `SPXID${num}${tag}`;
    const [r] = await commitImport(actor, [{ fileName: `ord.retur.${tag}.xlsx`, storeId: st.id, parsed: file([order(no, { trackingNo: resi })]) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    for (const q of [no, resi, `https://qr.example/order/${no}`, resi.toLowerCase()]) {
      const hits = await lookupOrders(q);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ orderNo: no, trackingNo: resi, marketplace: "SHOPEE", store: st.name, courier: "SPX", city: "Kab. Lamongan", province: "Jawa Timur", total: 50000 });
      expect(hits[0].lines[0]).toMatchObject({ qty: 2, itemId: item.id, itemName: item.name });
    }
    expect(await lookupOrders(`TIDAKADA${tag}XX`)).toHaveLength(0);
    expect((await lookupOrderById((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: no } })).id))?.orderNo).toBe(no);
  });

  it("retur dari form tertaut ke pesanan & mengisi data kosong; retur kedua untuk pesanan yang sama butuh konfirmasi", async () => {
    const { st, item } = await setup();
    const no = `262${num}B${tag}`, resi = `SPXID${num}B${tag}`, resi2 = `SPXID${num}C${tag}`;
    const [r] = await commitImport(actor, [{ fileName: `ord.retur2.${tag}.xlsx`, storeId: st.id, parsed: file([order(no, { trackingNo: resi, rawReturn: "Pengembalian sedang diproses" })]) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    // "Belum dicatat": pesanan berstatus Retur dari file tapi belum ada catatan ERP
    const before = await unloggedCounts({ storeId: st.id, channel: "SHP" });
    expect(before.fromFile - before.logged).toBeGreaterThanOrEqual(1);
    const base = { receivedAt: new Date(), marketplace: "SHOPEE", trackingNo: resi, orderNo: no, lines: [{ labelSku: `RTSKU${tag}`, qty: 2, itemId: item.id }] };
    const a = await createReturn(base, actor);
    cleanups.push(() => prisma.returnCase.delete({ where: { id: a.id } }).catch(() => {}));
    const o = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: no } });
    expect(o.returnCaseId).toBe(a.id); // tertaut
    expect(await prisma.returnCase.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ city: "KAB. LAMONGAN", province: "JAWA TIMUR", storeId: st.id }); // kosong → diisi dari pesanan
    const after = await unloggedCounts({ storeId: st.id, channel: "SHP" });
    expect(after.logged).toBe(before.logged + 1);
    expect((await lookupOrders(no))[0].existing.returns.map((x) => x.number)).toContain(a.number);
    // retur kedua (resi lain, pesanan sama) ditolak tanpa konfirmasi — juga bila hanya resi pesanan yang dikenal
    await expect(createReturn({ ...base, trackingNo: resi2 }, actor)).rejects.toThrow(/sudah punya retur/);
    const c = await createReturn({ ...base, trackingNo: `SPXID${num}D${tag}`, confirmDup: true }, actor);
    cleanups.push(() => prisma.returnCase.delete({ where: { id: c.id } }).catch(() => {}));
    expect(c.id).not.toBe(a.id);
    await expect(createReturn({ ...base, trackingNo: resi }, actor)).rejects.toThrow(StockError); // resi yang sama tetap ditolak seperti biasa
    // dibatalkan = tidak aktif lagi → boleh retur baru tanpa konfirmasi
  });

  it("komplain: tertaut, dan komplain kedua untuk pesanan yang sama butuh konfirmasi", async () => {
    const { st, item } = await setup();
    const no = `263${num}E${tag}`, resi = `SPXID${num}E${tag}`;
    const [r] = await commitImport(actor, [{ fileName: `ord.komp.${tag}.xlsx`, storeId: st.id, parsed: file([order(no, { trackingNo: resi })]) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const input = { date: new Date(), orderNo: no, trackingNo: resi, issueType: "PECAH", solution: "KIRIM_GANTI", lines: [{ labelSku: `RTSKU${tag}`, itemId: item.id, qty: 1, sendQty: 1 }] };
    const k = await createComplaint(input, actor);
    cleanups.push(() => prisma.complaint.delete({ where: { id: k.id } }).catch(() => {}));
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: no } })).complaintId).toBe(k.id);
    await expect(createComplaint(input, actor)).rejects.toThrow(/sudah punya komplain/);
    const k2 = await createComplaint({ ...input, confirmDup: true }, actor);
    cleanups.push(() => prisma.complaint.delete({ where: { id: k2.id } }).catch(() => {}));
    expect(k2.id).not.toBe(k.id);
  });
});
