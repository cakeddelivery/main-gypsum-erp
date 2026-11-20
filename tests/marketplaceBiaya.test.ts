import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { makeXlsx } from "./fixtures/xlsxMake";
import { parseMarketplaceFile } from "@/lib/marketplace/parse";
import { categoryOf, defaultCategory, sumFees } from "@/lib/marketplace/feeMap";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { affiliateReport, applyActuals, feeVsSettings, potonganReport } from "@/lib/marketplace/potongan";
import { listOrders, orderSummary, regionReport } from "@/lib/marketplace/report";
import { allocateFifo, allocationMap, stageOf, matchTiktokWithdrawals, matchWithdrawals, saldoNeedsAttention, saldoPanel, saldoStatus } from "@/lib/marketplace/saldo";

/** Tanggal jauh (2036) agar tidak bercampur data tes lain */
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

async function storeDL() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } })); // dijalankan paling akhir
  return made;
}
async function store() {
  const org = await prisma.organization.findFirstOrThrow();
  return (await prisma.store.findUnique({ where: { code: "MG" } })) ?? (await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } }));
}
const inc = (refNo: string, o: Partial<ParsedIncome> = {}): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at("2036-03-01"), releasedAt: at("2036-03-05"), released: 0, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {}, ...o });
const ord = (orderNo: string, o: Partial<ParsedOrder> = {}): ParsedOrder => ({ orderNo, orderedAt: at("2036-03-01"), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: "KOTA MALANG", province: "Jawa Timur", creatorHandle: null, affiliate: false, subtotal: 0, discount: 0, shippingPaid: 0, total: 10000, refundAmount: 0, returnQty: 0, lines: [{ sku: `AFF${tag}`, variation: null, name: "Produk", qty: 1, unitPrice: 10000, amount: 10000, returnQty: 0 }], ...o });
const file = (platform: "SHOPEE" | "TIKTOK", kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform, kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });

describe("Pemetaan biaya", () => {
  it("kolom bawaan Shopee & TikTok masuk kategori yang benar; kolom baru tetap 'BELUM' (tidak hilang)", () => {
    const d = (c: string, p?: "SHOPEE" | "TIKTOK") => defaultCategory(c, p);
    expect(d("Biaya Administrasi")).toBe("ADMIN");
    expect(d("Biaya Transaksi")).toBe("ADMIN");
    expect(d("Biaya komisi platform")).toBe("ADMIN");
    expect(d("Komisi dinamis")).toBe("ADMIN");
    expect(d("Biaya Layanan Pre-Order", "SHOPEE")).toBe("ADMIN");
    expect(d("Biaya layanan pre-order", "TIKTOK")).toBe("LAYANAN");
    expect(d("Biaya Proses Pesanan")).toBe("PROSES");
    expect(d("Biaya pemrosesan pesanan")).toBe("PROSES");
    expect(d("Biaya Gratis Ongkir XTRA - Program 1")).toBe("ONGKIR_PROGRAM");
    expect(d("Biaya layanan logistik", "TIKTOK")).toBe("RINCIAN"); // sudah termasuk di Ongkir
    expect(d("Ongkos Kirim yang Dibayarkan ke Jasa Kirim", "SHOPEE")).toBe("ONGKIR");
    expect(d("Gratis Ongkir dari Shopee", "SHOPEE")).toBe("ONGKIR");
    expect(d("Ongkos Kirim Pengembalian Barang", "SHOPEE")).toBe("ONGKIR");
    expect(d("Pengembalian Biaya Kirim", "SHOPEE")).toBe("ONGKIR");
    expect(d("Ongkir", "TIKTOK")).toBe("ONGKIR");
    expect(d("Biaya Komisi AMS")).toBe("AFFILIATE");
    expect(d("Komisi Afiliasi")).toBe("AFFILIATE");
    expect(d("Komisi Iklan Toko afiliasi")).toBe("AFFILIATE");
    expect(d("Diskon (dari belanja iklan)", "TIKTOK")).toBe("RINCIAN"); // rincian komisi, bukan iklan
    expect(d("Biaya Isi Saldo Otomatis")).toBe("IKLAN");
    expect(d("Premi")).toBe("ASURANSI");
    expect(d("Biaya Layanan Shopee Live XTRA")).toBe("LAYANAN");
    expect(d("Voucher disponsor oleh Penjual")).toBe("VOUCHER");
    expect(d("Diskon penjual", "TIKTOK")).toBe("INFO");
    expect(d("Jumlah Pengembalian Dana ke Pembeli", "SHOPEE")).toBe("REFUND");
    expect(d("Pengembalian Dana ke Pembeli", "SHOPEE")).toBe("INFO"); // grup info pembeli: tidak dijumlah
    expect(d("Jumlah Dibayar Pembeli", "SHOPEE")).toBe("INFO");
    expect(d("ID pesanan/penyesuaian")).toBe("ABAIKAN");
    expect(d("ID pesanan terkait")).toBe("ABAIKAN");
    expect(d("Perkiraan berat paket")).toBe("ABAIKAN");
    expect(d("PPh 22")).toBe("PAJAK");
    expect(d("Biaya Kampanye Misterius")).toBe("BELUM");
  });
  it("pemetaan buatan pengguna menimpa bawaan; jumlah per kategori & kolom belum dipetakan terpisah", () => {
    const ov = new Map([["SHOPEE|biaya kampanye misterius", "LAINNYA"], ["SHOPEE|premi", "ABAIKAN"]]);
    expect(categoryOf("SHOPEE", "Biaya  Kampanye Misterius", ov)).toBe("LAINNYA");
    expect(categoryOf("SHOPEE", "Premi", ov)).toBe("ABAIKAN");
    const t = sumFees("SHOPEE", [{ "Biaya Administrasi": -1000, "Biaya Transaksi": -200, Premi: -50, "Voucher disponsor oleh Penjual": -300, "Biaya Aneh": -7 }], undefined);
    expect(t.byCategory).toMatchObject({ ADMIN: -1200, ASURANSI: -50, VOUCHER: -300 });
    expect(t.unmapped).toEqual({ "Biaya Aneh": -7 });
    expect(t.counted).toBe(-1550); // voucher penjual mengurangi saldo di Shopee; kolom belum dikenal belum ikut sampai dipetakan
    expect(sumFees("TIKTOK", [{ "Diskon penjual": -300, "Biaya komisi platform": -100 }]).counted).toBe(-100); // di TikTok diskon penjual hanya info
  });
});

describe("File penghasilan berpola asli (sintetis)", () => {
  it("TikTok: Total Pendapatan + Σ potongan = penyelesaian; kolom ID/berat diabaikan; rincian tidak dijumlah", async () => {
    const head = ["ID pesanan/penyesuaian", "ID pesanan terkait", "Jenis transaksi", "Waktu pemesanan", "Waktu pembayaran pesanan", "Jumlah penyelesaian pembayaran", "Total Pendapatan", "Total Biaya", "Biaya komisi platform", "Komisi dinamis", "Biaya pemrosesan pesanan", "Ongkir", "Komisi Afiliasi", "Komisi Iklan Toko afiliasi", "Biaya layanan pre-order", "Biaya layanan logistik", "Biaya komisi sebelum diskon", "Diskon (dari belanja iklan)", "Perkiraan berat paket", "Subtotal sebelum diskon", "Diskon penjual"];
    const row = (id: string) => [id, "5786000000000000001", "Pesanan", "05/03/2036 10:00:00", "12/03/2036 09:00:00", 7350, 10000, -2650, -500, -700, -300, -400, -600, -100, -50, -250, -900, 400, 1200, 20000, -10000];
    const p = await parseMarketplaceFile(await makeXlsx([{ name: "Detail pesanan", rows: [head, row(`5785${num}001`), row(`5785${num}002`)] }]));
    const d = p.incomes[0].feeDetail;
    expect(Object.keys(d).some((k) => /^id|berat/i.test(k))).toBe(false); // kolom ID & berat tidak ikut
    expect(p.incomes[0].fees).toBe(2650);
    const sum = sumFees("TIKTOK", [d]);
    expect(sum.byCategory).toMatchObject({ ADMIN: -1200, PROSES: -300, ONGKIR: -400, AFFILIATE: -700, LAYANAN: -50, RINCIAN: -750 /* -250 -900 +400 */, INFO: -10000 + 20000 });
    expect(sum.counted).toBe(-2650); // sama dengan Total Biaya; rincian & info tidak dijumlah
    expect(7350).toBe(10000 + sum.counted); // Total Pendapatan + Σ potongan = penyelesaian
  });
  it("Shopee: kolom grup info pembeli tidak dobel; Pengembalian Biaya Kirim = ongkir; Harga Produk + Σ potongan = Total Penghasilan", async () => {
    const head = ["No.", "Lihat berdasarkan", "No. Pesanan", "Tanggal Dana Dilepaskan", "Total Penghasilan", "Harga Produk", "Biaya Administrasi", "Jumlah Pengembalian Dana ke Pembeli", "Pengembalian Biaya Kirim", "Voucher disponsor oleh Penjual", "Ongkos Kirim yang Dibayarkan ke Jasa Kirim", "Gratis Ongkir dari Shopee", "Jumlah Dibayar Pembeli", "Pengembalian Dana ke Pembeli", "Pro-rata Voucher Shopee"];
    const p = await parseMarketplaceFile(await makeXlsx([{ name: "Penghasilan", rows: [[], [], head, [1, "Order", `9${num}`, "2036-03-12 08:00", 8650, 10000, -1000, -300, 150, -200, -900, 900, 9700, -300, -50]] }]));
    const sum = sumFees("SHOPEE", [p.incomes[0].feeDetail]);
    expect(sum.byCategory).toMatchObject({ ADMIN: -1000, REFUND: -300, ONGKIR: 150, VOUCHER: -200, INFO: 9700 - 300 - 50 });
    expect(10000 + sum.counted).toBe(8650); // voucher penjual & kolom ongkir (-900 +900 +150) ikut dijumlah
  });
});

describe("TikTok baris iklan & penyesuaian", () => {
  it("nilai dari 'Jumlah penyesuaian': GMV Pay → ADS (iklan), penyesuaian komisi → ADJUST", async () => {
    const head = ["ID pesanan/penyesuaian", "Jenis transaksi", "Waktu pemesanan", "Waktu pembayaran pesanan", "Jumlah penyelesaian pembayaran", "Jumlah penyesuaian", "Total Pendapatan", "Total Biaya"];
    const p = await parseMarketplaceFile(await makeXlsx([{ name: "Detail pesanan", rows: [head, [`ADS${num}`, "Pembayaran GMV untuk Iklan TikTok", "10/03/2036 00:00:00", null, 0, -3872670, 0, 0], [`ADJ${num}`, "Penyesuaian komisi platform", "11/03/2036 00:00:00", null, 0, -1568, 0, 0], [`5787${num}`, "Pesanan", "05/03/2036 10:00:00", "12/03/2036 09:00:00", 5000, 0, 5000, 0]] }]));
    const by = (k: string) => p.incomes.find((i) => i.kind === k)!;
    expect(by("ADS")).toMatchObject({ released: -3872670 });
    expect(by("ADJUST")).toMatchObject({ released: -1568 });
    expect(by("ADS").releasedAt).not.toBeNull(); // tanggal cadangan: waktu pemesanan
  });
});

describe("Piutang → Di saldo → Ditarik (alokasi FIFO per pesanan)", () => {
  it("withdraw dari Keuangan menutup cair tertua; sebagian ditandai; kartu & tab konsisten; potongan = komponen COUNTED; tanpa transaksi/jurnal otomatis", async () => {
    const st = await storeDL();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `MPD${tag}`, name: `Saldo Shopee DL ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "shopee" } });
    const mine: (() => Promise<unknown>)[] = [() => prisma.bankAccount.delete({ where: { id: bank.id } })];
    try {
      const o = (n: number, d: string, total: number) => ord(`D${num}${n}`, { orderedAt: at(d), total, lines: [{ sku: `FIFO${tag}`, variation: null, name: "Produk", qty: 1, unitPrice: total, amount: total, returnQty: 0 }] });
      const fee = { "Biaya Administrasi": -1000, "Voucher disponsor oleh Penjual": -200, "Pengembalian Dana ke Pembeli": -777 }; // voucher counted (Shopee), kolom info tidak
      const orders = [o(1, "2036-09-01", 10000), o(2, "2036-09-02", 20000), o(3, "2036-09-03", 30000), o(4, "2036-09-03", 9000)];
      const rel = (n: number, d: string, v: number) => inc(`D${num}${n}`, { orderedAt: at("2036-09-01"), releasedAt: at(d), released: v, productAmt: v + 1200, feeDetail: fee });
      const incomes = [rel(1, "2036-09-01", 10000), rel(2, "2036-09-02", 20000), rel(3, "2036-09-03", 30000)]; // pesanan 4 belum cair
      const rs = await commitImport(actor, [{ fileName: `ord.fifo.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "ORDER", { orders }) }, { fileName: `inc.fifo.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes }) }]);
      mine.push(...rs.map((r) => () => undoImport(actor, r.importId)));
      const mk = (k: number, ref: string, amount: number, d: string) => prisma.financeTransaction.create({ data: { number: `TX-MPT-${tag}-F${k}`, source: "MANUAL", direction: "TRANSFER", amount: BigInt(amount), date: at(d), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-${tag}-F${k}`, createdBy: "t", withdrawRef: ref, storeId: st.id } });
      const f = { storeId: st.id, channel: "SHP", from: "2036-09-01", to: "2036-09-30" };
      // belum ada withdraw: semua cair masih di saldo
      let sum = await orderSummary(f);
      expect(sum.counts).toMatchObject({ ALL: 4, PIUTANG: 1, CAIR: 3, DITARIK: 0 });
      expect(sum).toMatchObject({ piutang: 9000, saldo: 60000, withdrawnMonth: 0 });
      expect(sum.fees).toBe(3600); // (1000 + 200 voucher) × 3 pesanan; kolom info tidak ikut
      expect(sum.fees).toBe(Math.abs((await potonganReport(f)).rows.filter((r) => r.counted).reduce((a, r) => a + r.value, 0))); // sama dengan halaman Potongan
      // withdraw 30.000 (3 Sep): menutup pesanan 1 (10.000) & 2 (20.000) penuh
      const w1 = await mk(1, `WD-F1${tag}`, 30000, "2036-09-03");
      mine.push(() => prisma.financeTransaction.delete({ where: { id: w1.id } }));
      const [tx0, j0] = await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()]);
      sum = await orderSummary(f);
      expect(sum.counts).toMatchObject({ PIUTANG: 1, CAIR: 1, DITARIK: 2 });
      expect(sum.saldo).toBe(30000);
      const ditarik = await listOrders({ ...f, tab: "DITARIK" });
      expect(ditarik.map((x) => x.orderNo).sort()).toEqual([`D${num}1`, `D${num}2`]);
      expect(ditarik[0].cover?.by[0]).toMatchObject({ date: "2036-09-03", ref: `WD-F1${tag}` });
      // withdraw 15.000 berikutnya (4 Sep): menutup pesanan 3 SEBAGIAN (15.000 dari 30.000)
      const w2 = await mk(2, `WD-F2${tag}`, 15000, "2036-09-04");
      mine.push(() => prisma.financeTransaction.delete({ where: { id: w2.id } }));
      const { covers } = await allocationMap({ storeId: st.id, channel: "SHP" });
      const o3 = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `D${num}3` }, include: { income: true } });
      expect(covers.get(o3.incomeId!)).toMatchObject({ withdrawn: 15000, by: [{ date: "2036-09-04", ref: `WD-F2${tag}`, amount: 15000 }] });
      expect(stageOf(30000, covers.get(o3.incomeId!))).toBe("SEBAGIAN");
      sum = await orderSummary(f);
      expect(sum.counts).toMatchObject({ CAIR: 1, DITARIK: 2 }); // sebagian tetap "Di saldo"
      expect(sum).toMatchObject({ saldo: 15000 });
      expect((await listOrders({ ...f, tab: "CAIR" })).map((x) => x.orderNo)).toEqual([`D${num}3`]);
      // withdraw melebihi cair yang diketahui → ditandai kelebihan, bukan menutup cair yang belum ada
      const w3 = await mk(3, `WD-F3${tag}`, 99000, "2036-09-05");
      mine.push(() => prisma.financeTransaction.delete({ where: { id: w3.id } }));
      const panel = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "SHP")!;
      expect(panel.over).toBe(84000); // 99.000 − sisa cair 15.000
      expect(await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()])).toEqual([tx0 + 2, j0]); // hanya 2 transaksi uji yang saya buat; tidak ada jurnal baru
    } finally {
      for (const c of mine.reverse()) await c().catch(() => {});
    }
  });
});

describe("Wilayah: nama diseragamkan & dikelompokkan", () => {
  it("varian penulisan Shopee/TikTok digabung dalam satu baris; nilai mentah tetap", async () => {
    const st = await store();
    const mk = (n: number, city: string, prov: string) => ord(`R${num}${n}`, { city, province: prov, orderedAt: at("2036-10-01"), lines: [{ sku: `RG${tag}`, variation: null, name: "P", qty: 1, unitPrice: 1000, amount: 1000, returnQty: 0 }], total: 1000 });
    const [r] = await commitImport(actor, [{ fileName: `ord.wil.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "ORDER", { orders: [mk(1, "KAB. BOGOR", "JAWA BARAT"), mk(2, "Kab. Bogor", "Jawa Barat"), mk(3, "KOTA JAKARTA TIMUR", "DKI JAKARTA"), mk(4, "Kota Administrasi Jakarta Timur", "DKI Jakarta")] }) }]);
    try {
      const rep = await regionReport({ storeId: st.id, channel: "TTS", from: "2036-10-01", to: "2036-10-31" });
      expect(rep.cities.find((c) => c.name === "Kab. Bogor")).toMatchObject({ orders: 2, province: "Jawa Barat" });
      expect(rep.cities.find((c) => c.name === "Kota Jakarta Timur")).toMatchObject({ orders: 2, province: "DKI Jakarta" });
      expect(rep.provinces.find((p) => p.name === "Jawa Barat")?.orders).toBe(2);
      expect(rep.provinces.find((p) => p.name === "DKI Jakarta")?.orders).toBe(2);
      expect(rep.cities.filter((c) => /bogor/i.test(c.name))).toHaveLength(1); // tidak lagi terpecah
      expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `R${num}1` } })).city).toBe("KAB. BOGOR"); // mentah tetap
    } finally {
      await undoImport(actor, r.importId);
    }
  });
});

describe("Potongan, aktual vs pengaturan, affiliate, withdraw", () => {
  it("laporan potongan: gross − potongan = cair, kolom baru tidak hilang, pemetaan mengubah hasil", async () => {
    const st = await store();
    const rows = Array.from({ length: 22 }, (_, i) => inc(`P${num}${i}`, { productAmt: 10000, released: 7723, feeDetail: { "Biaya Administrasi": -1000, "Biaya Proses Pesanan": -250, "Biaya Gratis Ongkir XTRA - A": -600, "Biaya Komisi AMS": -300, Premi: -50, "Biaya Kampanye Zeta": -77 } }));
    const [r] = await commitImport(actor, [{ fileName: `inc.biaya.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes: rows }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const f = { storeId: st.id, channel: "SHP", from: "2036-03-01", to: "2036-03-31" };
    const rep = await potonganReport(f);
    expect(rep.orders).toBe(22);
    expect(rep.gross).toBe(220000);
    expect(rep.byCategory.ADMIN).toBe(-22000);
    expect(rep.byCategory.PROSES).toBe(-5500);
    expect(rep.byCategory.ONGKIR_PROGRAM).toBe(-13200);
    expect(rep.byCategory.AFFILIATE).toBe(-6600);
    expect(rep.byCategory.ASURANSI).toBe(-1100);
    expect(rep.unmapped["Biaya Kampanye Zeta"]).toBe(-1694); // tetap tampil sebagai "belum dipetakan"
    expect(rep.residual).toBe(-1694); // kolom belum dipetakan belum ikut total → tampil sebagai selisih belum terjelaskan
    expect(rep.rows.find((x) => x.category === "ADMIN")!.pct).toBeCloseTo(10, 5);
    // dipetakan → pindah ke kategori
    await prisma.marketplaceFeeMap.create({ data: { platform: "SHOPEE", column: "biaya kampanye zeta", category: "IKLAN", updatedBy: "t" } });
    cleanups.push(() => prisma.marketplaceFeeMap.deleteMany({ where: { column: "biaya kampanye zeta" } }));
    const rep2 = await potonganReport(f);
    expect(rep2.byCategory.IKLAN).toBe(-1694);
    expect(rep2.residual).toBe(0); // setelah dipetakan: gross + potongan = cair
    expect(Object.keys(rep2.unmapped)).toHaveLength(0);

    // aktual vs pengaturan: admin 10%, ongkir xtra 6%, per pesanan 250
    const cmp = await feeVsSettings(f);
    expect(cmp.enough).toBe(true);
    expect(cmp.settingRows.find((x) => x.name === "Biaya Admin")).toMatchObject({ actual: 10 });
    expect(cmp.settingRows.find((x) => x.name === "Biaya Gratis Ongkir Xtra")).toMatchObject({ actual: 6 });
    expect(cmp.perOrder.actual).toBe(250);
    // "Pakai angka aktual": hanya mengubah pengaturan, tidak ada transaksi/jurnal baru
    const old = await prisma.setting.findUnique({ where: { key: "marketplace_fees" } });
    cleanups.push(async () => (old ? prisma.setting.update({ where: { key: "marketplace_fees" }, data: { value: old.value } }) : prisma.setting.deleteMany({ where: { key: "marketplace_fees" } })));
    const [tx0, j0] = await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()]);
    await applyActuals(actor, f);
    const saved = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: "marketplace_fees" } })).value);
    expect(saved.SHOPEE.fees.find((x: { name: string }) => x.name === "Biaya Admin").pct).toBe(10);
    expect(saved.SHOPEE.perOrder).toBe(250);
    expect(await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()])).toEqual([tx0, j0]);
  });

  it("affiliate: ditandai dari kreator TikTok atau komisi; laporan per kreator/kanal", async () => {
    const st = await store();
    const orders = [ord(`T${num}1`, { creatorHandle: `kreator${tag}`, affiliate: true }), ord(`T${num}2`), ord(`T${num}3`, { creatorHandle: `kreator${tag}`, affiliate: true })];
    const incomes = [inc(`T${num}1`, { released: 8000, productAmt: 10000, feeDetail: { "Komisi Afiliasi": -1000 } }), inc(`T${num}2`, { released: 9500, productAmt: 10000, feeDetail: { "Biaya komisi platform": -500 } }), inc(`T${num}3`, { released: 9000, productAmt: 10000, feeDetail: { "Komisi Afiliasi": -1000 } })];
    const st1 = { storeId: st.id };
    const rs = await commitImport(actor, [{ fileName: `ttord.aff.${tag}.xlsx`, ...st1, parsed: file("TIKTOK", "ORDER", { orders }) }, { fileName: `ttinc.aff.${tag}.xlsx`, ...st1, parsed: file("TIKTOK", "INCOME", { incomes }) }]);
    for (const r of rs.reverse()) cleanups.push(() => undoImport(actor, r.importId));
    const rep = await affiliateReport({ storeId: st.id, channel: "TTS", from: "2036-03-01", to: "2036-03-31" });
    expect(rep.totalOrders).toBe(3);
    expect(rep.aff.orders).toBe(2);
    expect(rep.pctOrders).toBeCloseTo(66.67, 1);
    expect(rep.aff.omzet).toBe(20000);
    expect(rep.aff.komisi).toBe(2000);
    expect(rep.komisiPct).toBeCloseTo(10, 5);
    expect(rep.byCreator.find((c) => c.name === `kreator${tag}`)).toMatchObject({ orders: 2, komisi: 2000 });
  });

  it("withdraw: cocok / belum di ERP / tidak ada di file; saldo & pengingat tidak membuat transaksi", async () => {
    const st = await storeDL();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `MPB${tag}`, name: `Saldo TikTok DL ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "tiktok" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const mkTx = (n: number, ref: string, amount: number, date: string) => prisma.financeTransaction.create({ data: { number: `TX-MPT-${tag}-${n}`, source: "MANUAL", direction: "TRANSFER", amount: BigInt(amount), date: at(date), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-${tag}-${n}`, createdBy: "t", withdrawRef: ref, storeId: st.id } });
    const t1 = await mkTx(1, `WD-A${tag}`, 50000, "2036-05-10");
    const t2 = await mkTx(2, `WD-C${tag}`, 7000, "2036-05-11");
    cleanups.push(() => prisma.financeTransaction.deleteMany({ where: { id: { in: [t1.id, t2.id] } } }));
    const wd = (refId: string, amount: number, d: string) => ({ txType: "Withdrawal", refId, requestedAt: at(d), doneAt: at(d), amount: -amount, status: "Berhasil" });
    const incomes = [inc(`W${num}1`, { released: 60000, productAmt: 60000, releasedAt: at("2036-05-09") }), inc(`ADS${num}`, { kind: "ADS", released: -3000, releasedAt: at("2036-05-09") })];
    const [r] = await commitImport(actor, [{ fileName: `ttinc.wd.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes, withdrawals: [wd(`WD-A${tag}`, 50000, "2036-05-10"), wd(`WD-B${tag}`, 1000, "2036-05-12")] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const m = await matchTiktokWithdrawals({ storeId: st.id, from: "2036-05-01", to: "2036-05-31" });
    const by = (ref: string) => m.find((x) => x.refId === ref);
    expect(by(`WD-A${tag}`)).toMatchObject({ status: "COCOK", fileAmount: 50000, erpAmount: 50000 });
    expect(by(`WD-B${tag}`)).toMatchObject({ status: "BELUM_DI_ERP", erpAmount: null });
    expect(by(`WD-C${tag}`)).toMatchObject({ status: "TIDAK_DI_FILE", fileAmount: null, erpAmount: 7000 });
    const [tx0, j0] = await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()]);
    const panel = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "TTS")!;
    // cair bersih 60.000 − iklan 3.000 = 57.000, withdraw tercatat 50.000 + 7.000 = 57.000 → saldo 0
    // WD-B ada di file tetapi belum tercatat di ERP: tetap nyata (mengurangi saldo) → melebihi cair yang diketahui
    expect(panel).toMatchObject({ cair: 57000, recorded: 58000, estimate: -1000, over: 1000, notInErp: 1, status: "KOSONG" });
    expect(await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()])).toEqual([tx0, j0]);
  });

  it("saldo berjalan FIFO: satu withdraw menutup cair beberapa hari; umur saldo menentukan status", () => {
    // cair 19 & 20 Nov, 21 Nov tidak withdraw per hari tapi 1x withdraw gabungan untuk 2 hari
    const cair = [{ date: "2036-11-19", amount: 40000 }, { date: "2036-11-20", amount: 30000 }, { date: "2036-11-21", amount: 20000 }];
    const r = allocateFifo(cair, [{ date: "2036-11-21", amount: 70000 }]);
    expect(r.coverage).toEqual([{ date: "2036-11-21", amount: 70000, covers: { from: "2036-11-19", to: "2036-11-20" } }]);
    expect(r.balance).toBe(20000);
    expect(r.oldest).toBe("2036-11-21"); // yang tersisa hanya cair 21 Nov
    expect(saldoStatus(r.balance, r.oldest, "2036-11-21")).toEqual({ status: "NORMAL", ageDays: 0 });
    // withdraw sebagian: menutup 19 Nov penuh + sebagian 20 Nov
    const p = allocateFifo(cair, [{ date: "2036-11-20", amount: 50000 }]);
    expect(p.coverage[0].covers).toEqual({ from: "2036-11-19", to: "2036-11-20" });
    expect(p.remaining).toEqual([{ date: "2036-11-20", amount: 20000 }, { date: "2036-11-21", amount: 20000 }]);
    expect(saldoStatus(p.balance, p.oldest, "2036-11-21")).toEqual({ status: "PERINGATAN", ageDays: 1 });
    expect(saldoStatus(40000, "2036-11-17", "2036-11-21").status).toBe("MERAH"); // 4 hari > 3
    expect(saldoStatus(40000, "2036-11-18", "2036-11-21").status).toBe("PERINGATAN"); // tepat 3 hari
    expect(saldoStatus(0, null, "2036-11-21").status).toBe("KOSONG");
    // potongan iklan (negatif) mengurangi saldo seperti withdraw tanpa tampil sebagai withdraw
    const a = allocateFifo([{ date: "2036-11-19", amount: 10000 }, { date: "2036-11-20", amount: -3000 }], []);
    expect(a.balance).toBe(7000);
    expect(a.coverage).toEqual([]);
    // withdraw hanya menutup cair yang sudah ada pada tanggalnya
    const early = allocateFifo([{ date: "2036-11-20", amount: 5000 }], [{ date: "2036-11-19", amount: 5000 }]);
    expect(early.balance).toBe(0);
    expect(early.over).toBe(5000);
    expect(early.remaining).toEqual([{ date: "2036-11-20", amount: 5000 }]);
  });

  it("withdraw gabungan 2 hari di database: saldo menutup cair tertua, pengingat memakai umur saldo", async () => {
    const st = await storeDL();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `MPG${tag}`, name: `Saldo Shopee DL ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "shopee" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const day = (back: number) => new Date(Date.now() - back * 86400000);
    const incomes = [inc(`G${num}1`, { released: 40000, productAmt: 40000, releasedAt: day(2) }), inc(`G${num}2`, { released: 30000, productAmt: 30000, releasedAt: day(1) }), inc(`G${num}3`, { released: 20000, productAmt: 20000, releasedAt: day(0) })];
    const [r] = await commitImport(actor, [{ fileName: `shp.gabung.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const before = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "SHP")!;
    // belum ada withdraw sama sekali: saldo tertua 2 hari lalu → peringatan; masuk daftar pengingat
    expect(before).toMatchObject({ estimate: 90000, status: "PERINGATAN", ageDays: 2 });
    expect((await saldoNeedsAttention()).some((m) => m.storeId === st.id && m.channel === "SHP")).toBe(true);
    // withdraw 1x untuk cair 2 hari (70.000): menutup 2 hari lalu + kemarin
    const tx = await prisma.financeTransaction.create({ data: { number: `TX-MPT-${tag}-G`, source: "MANUAL", direction: "TRANSFER", amount: 70000n, date: new Date(), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-${tag}-G`, createdBy: "t", storeId: st.id } });
    cleanups.push(() => prisma.financeTransaction.delete({ where: { id: tx.id } }));
    const after = (await saldoPanel({ storeId: st.id })).find((x) => x.channel === "SHP")!;
    expect(after).toMatchObject({ estimate: 20000, status: "NORMAL", ageDays: 0, todayCount: 1 });
    expect(after.coverage[0].covers?.from).not.toBe(after.coverage[0].covers?.to); // menutup lebih dari satu hari
  });
});

describe("Shopee Transaksi Saldo Penjual", () => {
  const head = ["Tanggal", "Jenis Transaksi", "Deskripsi", "Jumlah", "Saldo Akhir"];
  const rows = [["Laporan Transaksi Saldo Penjual"], [], head,
    ["2036-07-02 09:00", "Pengeluaran", "Isi Ulang Saldo Iklan Otomatis", -50000, 0],
    ["2036-07-03 10:00", "Pengeluaran", "Pembayaran Iklan", -30000, 0],
    ["2036-07-04 11:00", "Penarikan", "Penarikan Dana ke rekening", -100000, 0],
    ["2036-07-04 12:00", "Pemasukan", "Penghasilan dari Pesanan", 20000, 0]];
  it("terbaca toleran: iklan → ADS (IKLAN), penarikan → withdraw, sisanya info; unggah ulang tidak dobel; masuk Potongan, saldo & pencocokan", async () => {
    const st = await storeDL();
    const parsed = await parseMarketplaceFile(await makeXlsx([{ name: "Transaction Report", rows }]));
    expect(parsed).toMatchObject({ platform: "SHOPEE", kind: "INCOME" });
    expect(parsed.incomes.map((i) => i.released)).toEqual([-50000, -30000]);
    expect(parsed.withdrawals).toHaveLength(1);
    expect(parsed.info.note).toMatch(/2 iklan, 1 penarikan dana, 1 transaksi lain/);
    const [r] = await commitImport(actor, [{ fileName: `saldo.${tag}.xlsx`, storeId: st.id, parsed }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const [r2] = await commitImport(actor, [{ fileName: `saldo.${tag}.b.xlsx`, storeId: st.id, parsed }]);
    expect(r2).toMatchObject({ baru: 0, dilewati: 2 }); // periode tumpang tindih: tidak dobel
    expect((await potonganReport({ storeId: st.id, channel: "SHP", from: "2036-07-01", to: "2036-07-31" })).byCategory.IKLAN).toBe(-80000);
    // pencocokan penarikan Shopee: nominal sama & tanggal berdekatan
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `MPS${tag}`, name: `Saldo Shopee DL ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "shopee" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const tx = await prisma.financeTransaction.create({ data: { number: `TX-MPT-${tag}-S`, source: "MANUAL", direction: "TRANSFER", amount: 100000n, date: at("2036-07-04"), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-${tag}-S`, createdBy: "t", storeId: st.id } });
    cleanups.push(() => prisma.financeTransaction.delete({ where: { id: tx.id } }));
    const m = await matchWithdrawals({ storeId: st.id, channel: "SHP", from: "2036-07-01", to: "2036-07-31" });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ status: "COCOK", fileAmount: 100000, erpAmount: 100000 });
  });
  it("format tak dikenali: pesan memuat header yang terbaca", async () => {
    await expect(parseMarketplaceFile(await makeXlsx([{ name: "Lembar1", rows: [["Kolom X", "Kolom Y", "Kolom Z"], [1, 2, 3]] }]))).rejects.toThrow(/Kolom X \| Kolom Y \| Kolom Z/);
  });
});
