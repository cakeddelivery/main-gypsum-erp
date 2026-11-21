import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome } from "@/lib/marketplace/parse";
import { saldoPanel } from "@/lib/marketplace/saldo";

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
    const dupe = await mkTx(1, null, 60000, "2050-04-02"); // withdraw yang SAMA dengan file, tetapi tanpa ID referensi → tak cocok
    const later = await mkTx(2, null, 10000, "2050-04-20"); // jauh sesudah cakupan file → dipakai
    cleanups.push(() => prisma.financeTransaction.deleteMany({ where: { id: { in: [dupe.id, later.id] } } }));
    const wd = { txType: "Withdrawal", refId: `WD-${tag}`, requestedAt: at("2050-04-02"), doneAt: at("2050-04-02"), amount: -60000, status: "Berhasil" };
    const [r] = await commitImport(actor, [{ fileName: `tts.inc.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "INCOME", { incomes: [ev(`T${tag}1`, "2050-04-01", 100000), ev(`T${tag}2`, "2050-04-19", 50000)], withdrawals: [wd], periodFrom: at("2050-04-01"), periodTo: at("2050-04-03") }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const w = await walletOf(st.id, "TTS");
    // cair 150.000 − withdraw file 60.000 − withdraw Keuangan di luar cakupan 10.000 = 80.000 (bukan 20.000 bila 60.000 dikurangkan dua kali)
    expect(w.withdraw).toBe(70000);
    expect(w.estimate).toBe(80000);
    expect(w.ignoredErp).toMatchObject({ count: 1, amount: 60000 });
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
});
