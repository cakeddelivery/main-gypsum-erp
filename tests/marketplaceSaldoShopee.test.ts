import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { makeXlsx } from "./fixtures/xlsxMake";
import { commitImport, previewImport, undoImport } from "@/lib/marketplace/import";
import { parseMarketplaceFile, type ParsedIncome } from "@/lib/marketplace/parse";
import { potonganReport } from "@/lib/marketplace/potongan";
import { bookBalance, saldoPanel } from "@/lib/marketplace/saldo";
import { integrityCheck } from "@/lib/marketplace/integrity";

/** Fixture SINTETIS berpola sama dengan file asli Shopee (tanpa data nyata) */
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
  await prisma.setting.deleteMany({ where: { key: { startsWith: "marketplace_seller:" } } });
});
async function store() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const at = (d: string) => new Date(`${d}T03:00:00Z`);

// mutasi kronologis: [tanggal, tipe, deskripsi, no pesanan, jumlah]
const MUT: [string, string, string, string | null, number][] = [
  ["2040-08-03 09:00", "Penghasilan dari Pesanan", "Penghasilan dari Pesanan", `4${num}A`, 20000],
  ["2040-08-05 09:00", "Penghasilan dari Pesanan", "Penghasilan dari Pesanan", `4${num}B`, 30000],
  ["2040-08-06 10:00", "Penghasilan dari Pesanan", "Penghasilan dari Pesanan", `4${num}B`, -3000],
  ["2040-08-07 10:00", "Penyesuaian", "Adjustment for Affiliate Free Sample Shipping", null, -4000],
  ["2040-08-08 10:00", "Penyesuaian", "Kompensasi atas pesanan hilang", `4${num}C`, 5000],
  ["2040-08-09 11:00", "Pembayaran dengan Saldo Penjual", "Isi Ulang Saldo Iklan/Koin Penjual", null, -11100],
  ["2040-08-10 15:00", "Penarikan Dana", "Penarikan Dana", null, -25000],
];
async function balanceFile(opening = 1000, seller = "main.gypsum") {
  let bal = opening;
  const rows = MUT.map(([d, type, desc, no, amt]) => {
    bal += amt;
    return [d, type, desc, no, amt >= 0 ? "Transaksi Masuk" : "Transaksi Keluar", `${amt}.0`, "Berhasil", `${bal}.0`] as (string | number | null)[];
  }).reverse(); // file asli: terbaru dulu
  const masuk = MUT.filter((m) => m[4] > 0).reduce((a, m) => a + m[4], 0);
  const keluar = MUT.filter((m) => m[4] < 0).reduce((a, m) => a + m[4], 0);
  const sheet: (string | number | null)[][] = Array.from({ length: 17 }, () => []);
  sheet[5] = ["Username (Penjual)", seller];
  sheet[6] = ["Dari", "2040-08-01"];
  sheet[7] = ["Ke", "2040-08-31"];
  sheet[11] = ["Total Saldo Masuk", null, null, null, masuk];
  sheet[12] = ["Total Saldo Keluar", null, null, null, null, null, keluar];
  sheet.push(["Tanggal Transaksi", "Tipe Transaksi", "Deskripsi", "No. Pesanan", "Jenis Transaksi", "Jumlah", "Status", "Saldo Akhir"], ...rows);
  return makeXlsx([{ name: "Transaction Report", rows: sheet }]);
}
const adsCsv = (seller = "main.gypsum") => Buffer.from([
  "Riwayat Transaksi", "Mata uang:,IDR", `Username:,${seller}`, "Tanggal:,01/08/2040 -- 31/08/2040", "ID Toko:,123456", "",
  "Urutan,Waktu (dd/mm/yyyy),Deskripsi,Jumlah,Catatan",
  "1,09/08/2040 11:00,Isi Saldo Otomatis,100000,",
  "2,10/08/2040 08:00,Deduction for Product Ad (Auto Bidding - GMV Max),-60000,",
  "3,10/08/2040 09:00,Iklan Produk Otomatis,-20000,",
  "4,11/08/2040 09:00,Pengurangan untuk Iklan Toko (Bidding Manual),-10000,",
  "5,12/08/2040 09:00,ROAS Protection Free Ads Credit Rebate,2500,",
].join("\n"), "utf8");

describe("Shopee: Buku Saldo Penjual (my_balance_transaction_report)", () => {
  it("dibaca sesuai format asli: meta, header baris 18, kategori, angka float, total masuk/keluar", async () => {
    const p = await parseMarketplaceFile(await balanceFile());
    expect(p).toMatchObject({ platform: "SHOPEE", kind: "BALANCE" });
    expect(p.info.seller).toBe("main.gypsum");
    expect(p.balanceTx).toHaveLength(7);
    const cat = (c: string) => p.balanceTx!.filter((t) => t.category === c);
    expect(cat("PENGHASILAN").reduce((a, t) => a + t.amount, 0)).toBe(47000);
    expect(cat("PENARIKAN")).toHaveLength(1);
    expect(cat("TOPUP_IKLAN")[0].amount).toBe(-11100);
    expect(cat("AFFILIATE_SAMPEL")[0].amount).toBe(-4000);
    expect(cat("PENYESUAIAN")[0]).toMatchObject({ amount: 5000, orderNo: `4${num}C` });
    expect(p.withdrawals).toMatchObject([{ amount: 25000 }]);
    expect(p.incomes.map((i) => i.kind).sort()).toEqual(["ADJUST", "ADJUST", "TOPUP"]);
    expect(p.balanceTx![0].date.getTime()).toBeGreaterThan(p.balanceTx![6].date.getTime()); // terbaru dulu
    expect(p.info.note).not.toMatch(/⚠/); // total file = jumlah baris
    expect(p.info.summaryTotal).toBe(MUT.reduce((a, m) => a + m[4], 0));
  });

  it("impor idempoten; saldo menurut Shopee vs estimasi ERP sama bila penghasilan lengkap; selisih bila ada yang belum diimpor; pencocokan per pesanan", async () => {
    const st = await store();
    await prisma.setting.deleteMany({ where: { key: `marketplace_seller:${st.id}:SHP` } });
    const f = { fileName: `bal.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await balanceFile()) };
    const prev = await previewImport([f]);
    expect(prev.files[0]).toMatchObject({ kind: "BALANCE", total: 7, baru: 7, dilewati: 0 });
    const [r] = await commitImport(actor, [f]);
    cleanups.push(() => undoImport(actor, r.importId));
    expect(r).toMatchObject({ baru: 7, dilewati: 0 });
    expect(await commitImport(actor, [{ ...f, fileName: `bal2.${tag}.xlsx` }])).toMatchObject([{ baru: 0, dilewati: 7 }]); // unggah ulang: tidak dobel
    expect(await prisma.marketplaceBalanceTx.count({ where: { storeId: st.id, channel: "SHP" } })).toBe(7);
    // belum ada file penghasilan: saldo Shopee 1000+47000−4000+5000−11100−25000 = 12.900; ERP baru tahu penyesuaian/isi saldo/withdraw
    let bb = (await bookBalance(st.id))!;
    expect(bb).toMatchObject({ opening: 1000, shopee: 12900, asOf: "2040-08-10" });
    expect(bb.diff).toBe(47000); // penghasilan pesanan belum diimpor
    // impor file penghasilan lengkap (event per pesanan: A 20.000, B 30.000 + refund −3.000)
    const ev = (no: string, v: number, d: string): ParsedIncome => ({ kind: "ORDER", refNo: no, orderedAt: at("2040-08-01"), releasedAt: at(d), released: v, productAmt: v, refundAmt: 0, fees: 0, feeDetail: {} });
    const [ri] = await commitImport(actor, [{ fileName: `inc.bal.${tag}.xlsx`, storeId: st.id, parsed: { platform: "SHOPEE", kind: "INCOME", orders: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 3 }, incomes: [ev(`4${num}A`, 20000, "2040-08-03"), ev(`4${num}B`, 30000, "2040-08-05"), ev(`4${num}B`, -3000, "2040-08-06")] } }]);
    cleanups.push(() => undoImport(actor, ri.importId));
    bb = (await bookBalance(st.id))!;
    expect(bb.diff).toBe(0); // saldo menurut Shopee = estimasi ERP
    const rep = await integrityCheck({ month: "2040-08", storeId: st.id });
    const g = rep.groups.find((x) => x.channel === "SHP")!;
    expect(g.checks.find((c) => c.key === "h")).toMatchObject({ ok: true });
    expect(g.checks.find((c) => c.key === "i")).toMatchObject({ ok: true });
    // penarikan di buku saldo ikut saldo berjalan (FIFO)
    const panel = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "SHP")!;
    expect(panel.notInErp).toBe(1); // penarikan 25.000 di file, belum tercatat di Keuangan
    // koreksi file penghasilan salah → buku saldo menandai pesanan yang berbeda
    await prisma.marketplaceIncomeEvent.updateMany({ where: { income: { storeId: st.id, refNo: `4${num}A` } }, data: { released: 19000n } });
    const bad = await integrityCheck({ month: "2040-08", storeId: st.id });
    const h = bad.groups.find((x) => x.channel === "SHP")!.checks.find((c) => c.key === "h")!;
    expect(h.ok).toBe(false);
    expect(h.items?.[0]).toMatch(new RegExp(`4${num}A`));
  });
});

describe("Shopee: saldo iklan (adwords_bill CSV)", () => {
  it("terbaca: pemakaian & koreksi = biaya iklan aktual per jenis; isi saldo terpisah; PPN & saldo iklan tersisa", async () => {
    const p = await parseMarketplaceFile(adsCsv());
    expect(p).toMatchObject({ platform: "SHOPEE", kind: "ADSBILL" });
    expect(p.info.seller).toBe("main.gypsum");
    expect(p.incomes).toHaveLength(5);
    expect(p.incomes.every((i) => i.kind === "ADSUSE")).toBe(true);
    const st = await store();
    await prisma.setting.deleteMany({ where: { key: `marketplace_seller:${st.id}:SHP` } });
    const [r] = await commitImport(actor, [{ fileName: `ads.${tag}.csv`, storeId: st.id, parsed: p }]);
    cleanups.push(() => undoImport(actor, r.importId));
    expect(await commitImport(actor, [{ fileName: `ads2.${tag}.csv`, storeId: st.id, parsed: p }])).toMatchObject([{ baru: 0, dilewati: 5 }]);
    const rep = await potonganReport({ storeId: st.id, channel: "SHP", from: "2040-08-01", to: "2040-08-31" });
    // IKLAN = pemakaian aktual − rebate: 60.000 + 20.000 + 10.000 − 2.500 (isi saldo 100.000 bukan biaya)
    expect(rep.byCategory.IKLAN).toBe(-87500);
    expect(rep.adsInfo).toMatchObject({ usage: 87500, walletIn: 100000, walletBalance: 12500 });
    // saldo penjual TIDAK dikurangi dua kali (isi saldo di buku saldo; pemakaian dari saldo iklan)
    const panel = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "SHP");
    expect(panel?.cair ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("username di file saldo iklan divalidasi terhadap toko; CSV tak dikenal ditolak jelas", async () => {
    const st = await store();
    await prisma.setting.upsert({ where: { key: `marketplace_seller:${st.id}:SHP` }, create: { key: `marketplace_seller:${st.id}:SHP`, value: "main.gypsum" }, update: { value: "main.gypsum" } });
    const wrong = await parseMarketplaceFile(adsCsv("toko.lain"));
    expect((await previewImport([{ fileName: `ads3.${tag}.csv`, storeId: st.id, parsed: wrong }])).files[0].error).toMatch(/berbeda dengan penjual/);
    await expect(parseMarketplaceFile(Buffer.from("a,b,c\n1,2,3", "utf8"))).rejects.toThrow(/tidak dikenali/);
  });
});
