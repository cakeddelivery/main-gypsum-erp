import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome } from "@/lib/marketplace/parse";
import { createTransaction } from "@/lib/finance";
import { matchWithdrawals, pairWithdraws, saldoPanel, walletDetail, wdSummary } from "@/lib/marketplace/saldo";

const tag = Date.now().toString(36).slice(-4).toUpperCase();
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
async function mg() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "MG" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const file = (platform: "SHOPEE" | "TIKTOK", kind: "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform, kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });
const ev = (refNo: string, d: string, released: number): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at(d), releasedAt: at(d), released, productAmt: released, refundAmt: 0, fees: 0, feeDetail: {} });
const walletOf = async (storeId: string, ch: "SHP" | "TTS") => (await saldoPanel({ storeId })).find((x) => x.channel === ch)!.wallet;


// Rekening saldo marketplace bawaan (seed) dipakai bersama banyak tes Keuangan; withdraw-nya kini dikenali per toko, jadi
// dinetralkan selama berkas ini berjalan agar angka saldo hanya berasal dari data uji di sini.
let seededWalletBanks: string[] = [];
beforeAll(async () => {
  seededWalletBanks = (await prisma.bankAccount.findMany({ where: { marketplace: true }, select: { id: true } })).map((b) => b.id);
  await prisma.bankAccount.updateMany({ where: { id: { in: seededWalletBanks } }, data: { marketplace: false } });
});
afterAll(async () => {
  await prisma.bankAccount.updateMany({ where: { id: { in: seededWalletBanks } }, data: { marketplace: true } });
});

describe("Rincian saldo marketplace: saldo awal, satu sumber withdraw, acuan", () => {
  it("Shopee: saldo awal dari baris tertua Saldo Penjual (≠ 0) dan Saldo Akhir terbaru = angka resmi", async () => {
    const st = await dl();
    const imp = `t-${tag}-bal`;
    const [r] = await commitImport(actor, [{ fileName: `shp.inc.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes: [ev(`S${tag}1`, "2049-03-02", 30000)] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    // baris tertua: withdraw −100.000 → saldo akhir 50.000 ⇒ saldo awal 150.000; lalu penghasilan +30.000 → 80.000
    await prisma.marketplaceBalanceTx.createMany({ data: [
      { storeId: st.id, channel: "SHP", txKey: `${tag}a`, date: at("2049-03-01"), type: "Penarikan Dana", amount: -100000n, balanceAfter: 50000n, pos: 1, category: "PENARIKAN", importId: imp },
      { storeId: st.id, channel: "SHP", txKey: `${tag}b`, date: at("2049-03-02"), type: "Penghasilan dari Pesanan", amount: 30000n, balanceAfter: 80000n, pos: 0, category: "PENGHASILAN", importId: imp },
    ] });
    await prisma.marketplaceWithdrawal.create({ data: { storeId: st.id, channel: "SHP", txType: "Withdrawal", refId: `W${tag}`, requestedAt: at("2049-03-01"), doneAt: at("2049-03-01"), amount: -100000n, status: "ok", importId: imp } });
    cleanups.push(() => prisma.marketplaceBalanceTx.deleteMany({ where: { importId: imp } }));
    cleanups.push(() => prisma.marketplaceWithdrawal.deleteMany({ where: { importId: imp } }));
    const w = await walletOf(st.id, "SHP");
    expect(w.opening).toMatchObject({ amount: 150000, source: "FILE" });
    expect(w.estimate).toBe(80000); // 150.000 + 30.000 − 100.000
    expect(w.official).toMatchObject({ amount: 80000, source: "FILE", asOf: "2049-03-02" });
    expect(w.diff).toBe(0);
    expect(w.balance).toBe(80000);
    expect(w.basis).toBe("ACUAN");
  });

  it("TikTok: file penarikan = sumber utama; withdraw Keuangan tanpa ID referensi TIDAK dikurangkan dua kali; di luar cakupan file tetap dipakai", async () => {
    const st = await dl();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `SRB${tag}`, name: `Saldo TikTok DL ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "tiktok" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const mkTx = (n: number, ref: string | null, amount: number, date: string) => prisma.financeTransaction.create({ data: { number: `TX-SRB-${tag}-${n}`, source: "MANUAL", direction: "TRANSFER", amount: BigInt(amount), date: at(date), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-srb-${tag}-${n}`, createdBy: "t", withdrawRef: ref, storeId: st.id } });
    const dupe = await mkTx(1, null, 59000, "2050-04-02"); // di tanggal yang tercakup file, tetapi nominalnya tidak berpadanan dengan penarikan file mana pun → tak cocok
    const later = await mkTx(2, null, 10000, "2050-04-20"); // jauh sesudah cakupan file → dipakai
    cleanups.push(() => prisma.financeTransaction.deleteMany({ where: { id: { in: [dupe.id, later.id] } } }));
    const wd = { txType: "Withdrawal", refId: `WD-${tag}`, requestedAt: at("2050-04-02"), doneAt: at("2050-04-02"), amount: -60000, status: "Berhasil" };
    const [r] = await commitImport(actor, [{ fileName: `tts.inc.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`T${tag}1`, "2050-04-01", 100000), ev(`T${tag}2`, "2050-04-19", 50000)], withdrawals: [wd], periodFrom: at("2050-04-01"), periodTo: at("2050-04-03") }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const w = await walletOf(st.id, "TTS");
    // cair 150.000 − withdraw file 60.000 − withdraw Keuangan di luar cakupan 10.000 = 80.000 (59.000 tanpa padanan di file tidak dikurangkan)
    expect(w.withdraw).toBe(70000);
    expect(w.estimate).toBe(80000);
    expect(w.ignoredErp).toMatchObject({ count: 1, amount: 59000 });
    expect(w.causes.join(" ")).toMatch(/tidak ada padanan di file penarikan/);
    expect(w.basis).toBe("ESTIMASI");
    expect(w.opening.source).toBe("TIDAK_DIKETAHUI");
  });

  it("titik acuan (saldo Seller Center): saldo = acuan + mutasi sesudahnya; selisih & penyebab ditampilkan", async () => {
    const st = await mg(); // toko lain agar tidak tercampur data uji sebelumnya
    const [r] = await commitImport(actor, [{ fileName: `tts.inc2.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`U${tag}1`, "2051-05-01", 100000), ev(`U${tag}2`, "2051-05-05", 25000)] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    // Seller Center per 1 Mei: 120.000 (estimasi ERP 100.000 → saldo awal TikTok sebelum data = 20.000)
    const chk = await prisma.marketplaceWalletCheck.create({ data: { storeId: st.id, channel: "TTS", asOf: new Date("2051-05-01T00:00:00Z"), amount: 120000n, note: "uji", createdBy: "t" } });
    cleanups.push(() => prisma.marketplaceWalletCheck.delete({ where: { id: chk.id } }));
    const w = await walletOf(st.id, "TTS");
    expect(w.official).toMatchObject({ amount: 120000, source: "ISIAN", asOf: "2051-05-01" });
    expect(w.balance).toBe(145000); // 120.000 + cair 5 Mei 25.000
    expect(w.diff).toBe(20000);
    expect(w.basis).toBe("ACUAN");
  });

  it("TikTok: penyelesaian ±08.00 — acuan diisi sebelum 08.00 belum memuat penyelesaian hari itu; sesudahnya sudah termasuk", async () => {
    const st = await mg();
    const [r] = await commitImport(actor, [{ fileName: `tts.inc3.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`V${tag}1`, "2052-06-02", 50000)] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const mk = (time: string, amount: bigint) => prisma.marketplaceWalletCheck.create({ data: { storeId: st.id, channel: "TTS", asOf: new Date("2052-06-02T00:00:00Z"), asOfAt: new Date(`2052-06-02T${time}:00+07:00`), amount, createdBy: "t" } });
    const early = await mk("07:00", 100000n); // sebelum penyelesaian 08.00: saldo di Seller Center belum memuat 50.000
    cleanups.push(() => prisma.marketplaceWalletCheck.delete({ where: { id: early.id } }));
    expect((await walletOf(st.id, "TTS")).balance).toBe(150000); // 100.000 + penyelesaian hari itu
    const late = await mk("09:00", 150000n); // sesudah penyelesaian: sudah termasuk
    cleanups.push(() => prisma.marketplaceWalletCheck.delete({ where: { id: late.id } }));
    const w = await walletOf(st.id, "TTS");
    expect(w.official).toMatchObject({ amount: 150000, at: "09:00" });
    expect(w.balance).toBe(150000);
  });

  it("TikTok: withdraw mengurangi saldo saat PERMINTAAN; dana dalam perjalanan = withdraw Dalam Proses di Keuangan / file belum tercatat ≤ 4 hari", async () => {
    // toko khusus uji agar tidak tercampur data uji lain
    const org = await prisma.organization.findFirstOrThrow();
    const st = await prisma.store.create({ data: { code: `ZT${tag}`, name: `Toko Uji ZT${tag}`, organizationId: org.id } });
    cleanups.unshift(() => prisma.store.delete({ where: { id: st.id } }));
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `SRT${tag}`, name: `Saldo TikTok Toko Uji ZT${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "tiktok" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const tx = await prisma.financeTransaction.create({ data: { number: `TX-SRT-${tag}`, source: "MANUAL", direction: "TRANSFER", amount: 40000n, date: at("2053-07-03"), accountId: bank.id, status: "DALAM_PROSES", fingerprint: `fp-srt-${tag}`, createdBy: "t", withdrawRef: `WDA${tag}`, storeId: st.id } });
    cleanups.push(() => prisma.financeTransaction.delete({ where: { id: tx.id } }));
    const wd = (refId: string, amount: number, d: string) => ({ txType: "Withdrawal", refId, requestedAt: at(d), doneAt: at(d), amount: -amount, status: "Sedang diproses" });
    const [r] = await commitImport(actor, [{ fileName: `tts.inc4.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`X${tag}1`, "2053-07-01", 100000)], withdrawals: [wd(`WDA${tag}`, 40000, "2053-07-02"), wd(`WDB${tag}`, 10000, "2053-07-04")], periodFrom: at("2053-07-01"), periodTo: at("2053-07-04") }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const stores = await prisma.store.findMany({ select: { id: true, name: true, code: true } });
    const w = await walletDetail(stores.find((x) => x.id === st.id)!, "TTS", stores.length, undefined, undefined, new Date("2053-07-05T05:00:00Z"));
    // saldo = 100.000 − 40.000 − 10.000 (keduanya berkurang saat diminta); dalam perjalanan: WDA (Dalam Proses di Keuangan) + WDB (file, belum tercatat, ≤ 4 hari)
    expect(w.withdraw).toBe(50000);
    expect(w.estimate).toBe(50000);
    expect(w.transit).toMatchObject({ amount: 50000, count: 2 });
    // sebulan kemudian: uang sudah lama masuk → file yang belum tercatat tidak lagi dianggap di perjalanan; yang Dalam Proses di Keuangan tetap
    const later = await walletDetail(stores.find((x) => x.id === st.id)!, "TTS", stores.length, undefined, undefined, new Date("2053-08-05T05:00:00Z"));
    expect(later.transit).toMatchObject({ amount: 40000, count: 1 });
  });

  it("pencocokan withdraw TikTok file ↔ Keuangan tanpa ID: toleransi tanggal 0–4 hari (Shopee 2 hari)", () => {
    const d = (day: string) => new Date(`${day}T05:00:00Z`);
    const erp = [{ id: "e1", amount: 60000, date: d("2054-01-05"), withdrawRef: null }];
    const file = (day: string) => [{ refId: "WDX", amount: 60000, date: d(day) }];
    const st = (ch: "TTS" | "SHP", day: string) => pairWithdraws(ch, file(day), erp).find((x) => x.fileAmount !== null)!.status;
    expect(st("TTS", "2054-01-02")).toBe("COCOK"); // 3 hari
    expect(st("TTS", "2054-01-01")).toBe("COCOK"); // 4 hari
    expect(st("TTS", "2053-12-31")).toBe("BELUM_DI_ERP"); // 5 hari
    expect(st("SHP", "2054-01-02")).toBe("BELUM_DI_ERP"); // Shopee 3 hari > 2
  });

  it("pencocokan per HARI KALENDER WIB: file 00.00 vs Keuangan 23.59 empat hari kemudian cocok; jam malam Shopee vs 00.00 hari berikutnya cocok", () => {
    const w = (iso: string) => new Date(iso);
    const erp = [{ id: "e1", amount: 60000, date: w("2054-03-05T16:59:00Z"), withdrawRef: null }]; // 5 Mar 23.59 WIB
    const f = (iso: string) => [{ refId: "WDY", amount: 60000, date: w(iso) }];
    expect(pairWithdraws("TTS", f("2054-03-01T00:00:00+07:00"), erp)[0].status).toBe("COCOK"); // 4 hari kalender (4 hari 23 jam)
    expect(pairWithdraws("TTS", f("2054-02-28T23:00:00+07:00"), erp)[0].status).toBe("BELUM_DI_ERP"); // 5 hari kalender
    const erp2 = [{ id: "e2", amount: 70000, date: w("2054-03-05T17:00:00Z"), withdrawRef: null }]; // 6 Mar 00.00 WIB
    expect(pairWithdraws("SHP", [{ refId: "x", amount: 70000, date: w("2054-03-05T22:53:30+07:00") }], erp2)[0].status).toBe("COCOK");
  });

  it("ringkasan: penarikan file SEBELUM withdraw tercatat pertama dipisah (sebelum pencatatan dimulai)", () => {
    const d = (day: string) => new Date(`${day}T05:00:00Z`);
    const erp = [{ id: "e1", amount: 50000, date: d("2054-04-10"), withdrawRef: null }];
    const file = [{ refId: "a", amount: 11000, date: d("2054-04-01") }, { refId: "b", amount: 50000, date: d("2054-04-10") }, { refId: "c", amount: 22000, date: d("2054-04-12") }];
    const sm = wdSummary(pairWithdraws("SHP", file, erp));
    expect(sm).toMatchObject({ inFile: 3, ok: 1, firstDay: "2054-04-10", beforeSum: 11000, recentSum: 22000 });
    expect(sm.before).toHaveLength(1);
    expect(sm.recent).toHaveLength(1);
  });

  it("acuan Seller Center Rp 0 + jam diterima; mutasi sesudahnya menambah dari 0", async () => {
    const st = await mg();
    const [r] = await commitImport(actor, [{ fileName: `tts.inc4.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`Z${tag}1`, "2056-07-01", 80000), ev(`Z${tag}2`, "2056-07-03", 15000)] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const chk = await prisma.marketplaceWalletCheck.create({ data: { storeId: st.id, channel: "TTS", asOf: new Date("2056-07-02T00:00:00Z"), asOfAt: new Date("2056-07-02T22:45:00+07:00"), amount: 0n, createdBy: "t" } });
    cleanups.push(() => prisma.marketplaceWalletCheck.delete({ where: { id: chk.id } }));
    const w = await walletOf(st.id, "TTS");
    expect(w.official).toMatchObject({ amount: 0, source: "ISIAN", at: "22:45" });
    expect(w.basis).toBe("ACUAN");
    expect(w.balance).toBe(15000); // 0 + cair 3 Juli
  });

  it("rekening saldo BERSAMA (satu 'Saldo Penjual TikTok' untuk semua toko): toko withdraw ditetapkan dari padanan file; tersimpan; tak mengubah transaksi", async () => {
    const dlS = await dl(), mgS = await mg();
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const bank = await prisma.bankAccount.create({ data: { code: `SHB${tag}`, name: `Saldo Penjual TikTok ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "tiktok" } });
    cleanups.push(() => prisma.bankAccount.delete({ where: { id: bank.id } }));
    const mkTx = (n: number, ref: string | null, amount: number, date: string, storeId: string | null) => prisma.financeTransaction.create({ data: { number: `TX-SHB-${tag}-${n}`, source: "MANUAL", direction: "TRANSFER", amount: BigInt(amount), date: at(date), accountId: bank.id, status: "DIBUKUKAN", fingerprint: `fp-shb-${tag}-${n}`, createdBy: "t", withdrawRef: ref, storeId } });
    const a = await mkTx(1, null, 40000, "2055-02-03", null); // tanpa toko & tanpa ref → dari file DL (nominal & tanggal)
    const b = await mkTx(2, null, 70000, "2055-02-04", mgS.id); // toko tercatat MG, file MG cocok
    const c = await mkTx(3, `REFC${tag}`, 25000, "2055-02-05", mgS.id); // tercatat MG tetapi ID referensi ada di file DL → DL (file lebih dipercaya)
    cleanups.push(() => prisma.marketplaceWithdrawLink.deleteMany({ where: { txId: { in: [a.id, b.id, c.id] } } }));
    cleanups.push(() => prisma.financeTransaction.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } }));
    const wd = (refId: string, amount: number, d: string) => ({ txType: "Withdrawal", refId, requestedAt: at(d), doneAt: at(d), amount: -amount, status: "Berhasil" });
    const inc = (n: number) => ev(`SH${tag}${n}`, "2055-02-01", 500000);
    const [rd] = await commitImport(actor, [{ fileName: `shb.dl.${tag}.xlsx`, storeId: dlS.id, parsed: file("TIKTOK", "INCOME", { incomes: [inc(1)], withdrawals: [wd(`WDDL1${tag}`, 40000, "2055-02-03"), wd(`REFC${tag}`, 25000, "2055-02-05"), wd(`WDDL3${tag}`, 90000, "2055-02-06")] }) }]);
    const [rm] = await commitImport(actor, [{ fileName: `shb.mg.${tag}.xlsx`, storeId: mgS.id, parsed: file("TIKTOK", "INCOME", { incomes: [inc(2)], withdrawals: [wd(`WDMG1${tag}`, 70000, "2055-02-04")] }) }]);
    cleanups.push(() => undoImport(actor, rm.importId));
    cleanups.push(() => undoImport(actor, rd.importId));
    const [tx0, j0] = await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()]);
    const mDl = await matchWithdrawals({ storeId: dlS.id, channel: "TTS", from: "2055-02-01", to: "2055-02-28" });
    const mMg = await matchWithdrawals({ storeId: mgS.id, channel: "TTS", from: "2055-02-01", to: "2055-02-28" });
    const by = (m: typeof mDl, refId: string) => m.find((x) => x.refId === refId);
    expect(by(mDl, `WDDL1${tag}`)).toMatchObject({ status: "COCOK", erpAmount: 40000, via: "FILE_NOMINAL" });
    expect(by(mDl, `REFC${tag}`)).toMatchObject({ status: "COCOK", erpAmount: 25000, via: "FILE_REF" }); // meski transaksi mencatat MG
    expect(by(mDl, `WDDL3${tag}`)).toMatchObject({ status: "BELUM_DI_ERP" }); // benar-benar belum dicatat
    expect(by(mMg, `WDMG1${tag}`)).toMatchObject({ status: "COCOK", erpAmount: 70000 });
    expect(mMg.some((x) => x.erpAmount === 25000 || x.erpAmount === 40000)).toBe(false); // tidak ikut ke MG
    // penetapan dari file tersimpan; transaksi & jurnal tidak berubah
    const links = await prisma.marketplaceWithdrawLink.findMany({ where: { txId: { in: [a.id, c.id] } } });
    expect(links.map((l) => l.via).sort()).toEqual(["FILE_NOMINAL", "FILE_REF"]);
    expect(links.every((l) => l.storeId === dlS.id)).toBe(true);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: c.id } })).storeId).toBe(mgS.id);
    expect(await Promise.all([prisma.financeTransaction.count(), prisma.journal.count()])).toEqual([tx0, j0]);
    // hanya 90.000 yang memang belum dicatat (bukan semua penarikan DL)
    expect(mDl.filter((x) => x.status === "BELUM_DI_ERP")).toHaveLength(1);
  });

  it("withdraw baru dari rekening saldo marketplace TIDAK diberi toko default: harus dipilih (PERLU_DITINJAU bila tanpa toko)", async () => {
    const coa = await prisma.coaAccount.findFirstOrThrow();
    const wallet = await prisma.bankAccount.create({ data: { code: `SHW${tag}`, name: `Saldo Penjual Shopee ${tag}`, coaAccountId: coa.id, marketplace: true, aliases: "shopee" } });
    const dest = await prisma.bankAccount.create({ data: { code: `SHD${tag}`, name: `Seabank uji ${tag}`, coaAccountId: coa.id } });
    cleanups.push(() => prisma.bankAccount.deleteMany({ where: { id: { in: [wallet.id, dest.id] } } }));
    const def = await prisma.setting.upsert({ where: { key: "default_store_id" }, create: { key: "default_store_id", value: (await mg()).id }, update: {} });
    void def;
    const { transaction } = await createTransaction({ direction: "TRANSFER", amount: 12000, date: at("2055-03-01"), accountId: wallet.id, toAccountId: dest.id }, "MANUAL", { id: "t", name: "Tester" }, { submit: true });
    cleanups.push(() => prisma.financeTransaction.delete({ where: { id: transaction.id } }));
    expect(transaction.storeId).toBeNull();
    expect(transaction.status).toBe("PERLU_DITINJAU");
  });
});
