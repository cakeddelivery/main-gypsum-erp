import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { categoryOf, defaultCategory, sumFees } from "@/lib/marketplace/feeMap";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { affiliateReport, applyActuals, feeVsSettings, potonganReport } from "@/lib/marketplace/potongan";
import { matchTiktokWithdrawals, missingWithdrawToday, saldoPanel } from "@/lib/marketplace/saldo";

/** Tanggal jauh (2036) agar tidak bercampur data tes lain */
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

async function store() {
  const org = await prisma.organization.findFirstOrThrow();
  return (await prisma.store.findUnique({ where: { code: "MG" } })) ?? (await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } }));
}
const inc = (refNo: string, o: Partial<ParsedIncome> = {}): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at("2036-03-01"), releasedAt: at("2036-03-05"), released: 0, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {}, ...o });
const ord = (orderNo: string, o: Partial<ParsedOrder> = {}): ParsedOrder => ({ orderNo, orderedAt: at("2036-03-01"), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: "KOTA MALANG", province: "Jawa Timur", creatorHandle: null, affiliate: false, subtotal: 0, discount: 0, shippingPaid: 0, total: 10000, refundAmount: 0, returnQty: 0, lines: [{ sku: `AFF${tag}`, variation: null, name: "Produk", qty: 1, unitPrice: 10000, amount: 10000, returnQty: 0 }], ...o });
const file = (platform: "SHOPEE" | "TIKTOK", kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform, kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });

describe("Pemetaan biaya", () => {
  it("kolom bawaan Shopee & TikTok masuk kategori yang benar; kolom baru tetap 'BELUM' (tidak hilang)", () => {
    const d = defaultCategory;
    expect(d("Biaya Administrasi")).toBe("ADMIN");
    expect(d("Biaya Transaksi")).toBe("ADMIN");
    expect(d("Biaya komisi platform")).toBe("ADMIN");
    expect(d("Komisi dinamis")).toBe("ADMIN");
    expect(d("Biaya Layanan Pre-Order")).toBe("ADMIN");
    expect(d("Biaya Proses Pesanan")).toBe("PROSES");
    expect(d("Biaya pemrosesan pesanan")).toBe("PROSES");
    expect(d("Biaya Gratis Ongkir XTRA - Program 1")).toBe("ONGKIR_PROGRAM");
    expect(d("Biaya layanan logistik")).toBe("ONGKIR_PROGRAM");
    expect(d("Ongkos Kirim yang Dibayarkan ke Jasa Kirim")).toBe("ONGKIR");
    expect(d("Ongkir")).toBe("ONGKIR");
    expect(d("Biaya Komisi AMS")).toBe("AFFILIATE");
    expect(d("Komisi Afiliasi")).toBe("AFFILIATE");
    expect(d("Komisi Iklan Toko afiliasi")).toBe("AFFILIATE");
    expect(d("Diskon (dari belanja iklan)")).toBe("IKLAN");
    expect(d("Biaya Isi Saldo Otomatis")).toBe("IKLAN");
    expect(d("Premi")).toBe("ASURANSI");
    expect(d("Biaya Layanan Shopee Live XTRA")).toBe("LAYANAN");
    expect(d("Voucher disponsor oleh Penjual")).toBe("VOUCHER");
    expect(d("Diskon penjual")).toBe("VOUCHER");
    expect(d("Jumlah Pengembalian Dana ke Pembeli")).toBe("REFUND");
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
    expect(t.counted).toBe(-1257); // voucher (info) tidak mengurangi saldo; kolom belum dikenal tetap dihitung
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
    expect(rep.residual).toBe(0); // gross + semua potongan = cair
    expect(rep.rows.find((x) => x.category === "ADMIN")!.pct).toBeCloseTo(10, 5);
    // dipetakan → pindah ke kategori
    await prisma.marketplaceFeeMap.create({ data: { platform: "SHOPEE", column: "biaya kampanye zeta", category: "IKLAN", updatedBy: "t" } });
    cleanups.push(() => prisma.marketplaceFeeMap.deleteMany({ where: { column: "biaya kampanye zeta" } }));
    const rep2 = await potonganReport(f);
    expect(rep2.byCategory.IKLAN).toBe(-1694);
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
    const st = await store();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `MPB${tag}`, name: `Saldo TikTok MG ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "tiktok" } });
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
    const panel = (await saldoPanel({ from: "2036-05-01", to: "2036-05-31", storeId: st.id })).find((x) => x.channel === "TTS")!;
    expect(panel).toMatchObject({ cair: 60000, ads: -3000, recorded: 57000, estimate: 0 });
    expect(await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()])).toEqual([tx0, j0]);
  });

  it("pengingat: ada saldo belum ditarik & belum ada withdraw tercatat hari ini → masuk daftar pengingat", async () => {
    const st = await store();
    const now = new Date();
    const [r] = await commitImport(actor, [{ fileName: `ttinc.ingat.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes: [inc(`R${num}1`, { released: 5000, productAmt: 5000, releasedAt: now, orderedAt: now })] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const missing = await missingWithdrawToday(now);
    expect(missing.some((m) => m.storeId === st.id && m.channel === "SHP")).toBe(true);
  });
});
