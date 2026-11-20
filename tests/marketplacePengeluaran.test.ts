import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { loadTargets, lostOrdersWithoutCompensation, pengeluaranReport, saveTargets, targetKey } from "@/lib/marketplace/pengeluaran";

const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const at = (d: string) => new Date(`${d}T03:00:00Z`);
async function dl() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const ev = (refNo: string, d: string, o: Partial<ParsedIncome>): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at(d), releasedAt: at(d), released: 0, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {}, ...o });
const file = (kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform: "SHOPEE", kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });
const lost = (orderNo: string): ParsedOrder => ({ orderNo, orderedAt: at("2041-05-02"), paidAt: null, completedAt: null, rawStatus: "Pesanan Hilang", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: "KAB. BOGOR", province: "JAWA BARAT", creatorHandle: null, affiliate: false, subtotal: 0, discount: 0, shippingPaid: 0, total: 45000, refundAmount: 0, returnQty: 0, lines: [{ sku: "X", variation: null, name: "X", qty: 1, unitPrice: 45000, amount: 45000, returnQty: 0 }] });

describe("Laporan pengeluaran marketplace", () => {
  it("sektor lengkap per bulan: admin, proses, ongkir, affiliate, sampel, iklan aktual + PPN, hilang (kompensasi), refund; bandingkan bulan lalu; OVERCOST dari target", async () => {
    const st = await dl();
    // Bulan lalu (Apr 2041): harga jual 100.000, admin 10.000 (10%)
    const apr = [ev(`${num}P1`, "2041-04-10", { productAmt: 100000, released: 89000, feeDetail: { "Biaya Administrasi": -10000, "Biaya Proses Pesanan": -1000 } })];
    // Bulan ini (Mei): harga jual 100.000 → admin 15.000 (15%), proses 2.000, Xtra 5.000, AMS 3.000, refund 4.000
    const mei = [ev(`${num}P2`, "2041-05-10", { productAmt: 100000, released: 71000, feeDetail: { "Biaya Administrasi": -15000, "Biaya Proses Pesanan": -2000, "Biaya Gratis Ongkir XTRA - A": -5000, "Biaya Komisi AMS": -3000, "Jumlah Pengembalian Dana ke Pembeli": -4000 } })];
    const lostNo = `${num}HIL`;
    const adj = (refNo: string, d: string, amount: number, desc: string): ParsedIncome => ({ kind: "ADJUST", refNo, orderedAt: at(d), releasedAt: at(d), released: amount, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: { [desc]: amount } });
    const ads = (refNo: string, d: string, amount: number, desc: string): ParsedIncome => ({ kind: "ADSUSE", refNo, orderedAt: at(d), releasedAt: at(d), released: amount, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: { [desc]: amount } });
    const rs = await commitImport(actor, [
      { fileName: `pg.apr.${tag}.xlsx`, storeId: st.id, parsed: file("INCOME", { incomes: apr }) },
      { fileName: `pg.mei.${tag}.xlsx`, storeId: st.id, parsed: file("INCOME", { incomes: [...mei, adj(`${num}S1`, "2041-05-12", -4000, "Adjustment for Affiliate Free Sample Shipping"), adj(lostNo, "2041-05-14", 45000, "Kompensasi atas pesanan hilang"), adj(`${num}S2`, "2041-05-15", -1000, "Penyesuaian saldo dilakukan untuk pesanan"),
        { kind: "TOPUP", refNo: `${num}T1`, orderedAt: at("2041-05-16"), releasedAt: at("2041-05-16"), released: -11100, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {} },
        ads(`${num}A0`, "2041-05-16", 10000, "Isi Saldo Otomatis"), ads(`${num}A1`, "2041-05-17", -6000, "Iklan Produk Otomatis"), ads(`${num}A2`, "2041-05-18", -3000, "Deduction for Product Ad (Auto Bidding - GMV Max)"), ads(`${num}A3`, "2041-05-19", 500, "ROAS Protection Free Ads Credit Rebate")] }) },
      { fileName: `ord.mei.${tag}.xlsx`, storeId: st.id, parsed: file("ORDER", { orders: [lost(lostNo), lost(`${num}HIL2`)] }) },
    ]);
    for (const r of rs) cleanups.push(() => undoImport(actor, r.importId)); // dibatalkan dari yang terbaru
    const rep = await pengeluaranReport({ month: "2041-05", storeId: st.id, channel: "SHP" });
    const row = (k: string) => rep.rows.find((r) => r.key === k)!;
    expect(rep.gross).toBe(100000);
    expect(row("ADMIN")).toMatchObject({ value: 15000, pct: 15, prevValue: 10000, prevPct: 10 });
    expect(row("PROSES").value).toBe(2000);
    expect(row("ONGKIR_PROGRAM").value).toBe(5000);
    expect(row("AFFILIATE").value).toBe(3000);
    expect(row("AFFILIATE_SAMPEL").value).toBe(4000);
    expect(row("REFUND").value).toBe(4000);
    expect(row("IKLAN").value).toBe(8500); // 6.000 + 3.000 − rebate 500 (isi saldo bukan biaya)
    expect(row("PPN_IKLAN").value).toBe(1100); // 11.100 − 11.100/1,11
    expect(row("PESANAN_HILANG").value).toBe(-45000); // kompensasi mengurangi biaya
    expect(row("PENYESUAIAN").value).toBe(1000);
    // pesanan hilang yang BELUM dikompensasi terdeteksi
    expect(await lostOrdersWithoutCompensation({ month: "2041-05", storeId: st.id, channel: "SHP" })).toMatchObject({ count: 1, value: 45000 });
    // target bawaan dari pengaturan Produk › Biaya (admin Shopee 8,25%) → 15% = OVERCOST
    expect(row("ADMIN")).toMatchObject({ target: 8.25, targetSource: "PENGATURAN", over: true });
    // sektor tanpa target: rata-rata bulan lalu + 20% → proses 1% × 1,2 = 1,2% → 2% = OVERCOST
    expect(row("PROSES")).toMatchObject({ target: 1.2, targetSource: "RATA3", over: true });
    expect(rep.overs).toEqual(expect.arrayContaining(["ADMIN", "PROSES"]));
    // target yang diatur menimpa
    const old = await loadTargets();
    cleanups.push(() => saveTargets(actor, old));
    await saveTargets(actor, { ...old, [targetKey("SHP", "ADMIN")]: 20 });
    const rep2 = await pengeluaranReport({ month: "2041-05", storeId: st.id, channel: "SHP" });
    expect(rep2.rows.find((r) => r.key === "ADMIN")).toMatchObject({ target: 20, targetSource: "ATUR", over: false });
    expect(rep2.total).toBe(rep2.rows.filter((r) => !r.info).reduce((a, r) => a + r.value, 0));
  });
});
