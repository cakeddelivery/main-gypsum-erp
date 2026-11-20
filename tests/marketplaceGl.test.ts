import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome } from "@/lib/marketplace/parse";
import { adsLines, glTrialBalance, linesFromNet, rebuildGl, suggestOpening } from "@/lib/marketplace/gl";

const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
  await rebuildGl().catch(() => {});
});
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const file = (platform: "SHOPEE" | "TIKTOK", incomes: ParsedIncome[]): ParsedFile => ({ platform, kind: "INCOME", orders: [], incomes, withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 } });
const ev = (kind: ParsedIncome["kind"], refNo: string, d: string, o: Partial<ParsedIncome>): ParsedIncome => ({ kind, refNo, orderedAt: at(d), releasedAt: at(d), released: 0, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {}, ...o });
async function dl() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}

describe("Buku bayangan marketplace (simulasi)", () => {
  it("linesFromNet: selisih apa pun masuk 6-1640 sehingga jurnal selalu seimbang", () => {
    const l = linesFromNet(new Map([["1-1212", 80000], ["4-1100", -100000], ["6-1510", 15000]]));
    expect(l.reduce((a, x) => a + x.debit - x.credit, 0)).toBe(0);
    expect(l.find((x) => x.account === "6-1640")).toMatchObject({ debit: 5000 });
  });

  it("isi saldo iklan: saldo iklan naik sebesar file iklan, selisih dengan saldo penjual = PPN iklan (beban); pemakaian & rebate", () => {
    const e = (kind: string, released: number, desc?: string) => ({ releasedAt: new Date(), released, productAmt: 0, feeDetail: desc ? { [desc]: released } : {}, kind });
    const l = adsLines([e("TOPUP", -11100), e("ADSUSE", 10000, "Isi Saldo"), e("ADSUSE", -6000, "GMV Max"), e("ADSUSE", 500, "Rebate iklan")], "1-1212", "1-1222", "SHP");
    const by = (a: string) => { const x = l.find((y) => y.account === a); return x ? x.debit - x.credit : 0; };
    expect(by("1-1212")).toBe(-11100);
    expect(by("1-1222")).toBe(4500);
    expect(by("6-1620")).toBe(1100);
    expect(by("6-1610")).toBe(5500);
    expect(l.reduce((a, x) => a + x.debit - x.credit, 0)).toBe(0);
  });

  it("diturunkan dari data impor: cair pesanan, iklan, GMV Pay TikTok, saldo pembuka; tidak menyentuh jurnal nyata; bisa dibangun ulang", async () => {
    const st = await dl();
    const realBefore = await prisma.journal.count();
    const shp = await commitImport(actor, [{ fileName: `gl.shp.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", [
      ev("ORDER", `${num}G1`, "2042-05-10", { productAmt: 100000, released: 80000, feeDetail: { "Biaya Administrasi": -15000, "Biaya Proses Pesanan": -2000, "Biaya Komisi AMS": -3000 } }),
      ev("ORDER", `${num}G2`, "2042-05-10", { productAmt: 60000, released: 50000, feeDetail: { "Biaya Administrasi": -5000 } }), // selisih 5.000 tak terjelaskan
      ev("TOPUP", `${num}T1`, "2042-05-12", { released: -11100 }),
      ev("ADSUSE", `${num}A1`, "2042-05-12", { released: 10000, feeDetail: { "Isi Saldo": 10000 } }),
      ev("ADSUSE", `${num}A2`, "2042-05-13", { released: -6000, feeDetail: { "GMV Max": -6000 } }),
    ]) }]);
    cleanups.push(() => undoImport(actor, shp[0].importId));
    const tts = await commitImport(actor, [{ fileName: `gl.tts.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", [ev("ADS", `${num}M1`, "2042-05-11", { released: -7000 })]) }]);
    cleanups.push(() => undoImport(actor, tts[0].importId));
    await prisma.marketplaceGlOpening.deleteMany({ where: { storeId: st.id, channel: "SHP", wallet: "PENJUAL" } });
    await prisma.marketplaceGlOpening.create({ data: { storeId: st.id, channel: "SHP", wallet: "PENJUAL", asOf: new Date("2026-11-20"), amount: 200000n, source: "MANUAL", createdBy: "t" } });
    cleanups.push(() => prisma.marketplaceGlOpening.deleteMany({ where: { storeId: st.id, channel: "SHP", wallet: "PENJUAL" } }));

    const r1 = await rebuildGl();
    expect(r1.journals).toBeGreaterThan(0);
    const mine = await prisma.marketplaceGlJournal.findMany({ where: { storeId: st.id, OR: [{ date: { gte: new Date("2042-05-01"), lt: new Date("2042-06-01") } }, { kind: "OPEN", channel: "SHP" }] }, include: { lines: true } });
    // semua jurnal seimbang
    for (const j of mine) expect(j.lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    const settle = mine.find((j) => j.kind === "SETTLE")!;
    const by = (j: typeof settle, a: string) => { const x = j.lines.find((l) => l.account === a); return x ? Number(x.debit) - Number(x.credit) : 0; };
    expect(by(settle, "1-1212")).toBe(130000);
    expect(by(settle, "4-1100")).toBe(-160000);
    expect(by(settle, "6-1510")).toBe(20000);
    expect(by(settle, "6-1520")).toBe(2000);
    expect(by(settle, "6-1550")).toBe(3000);
    expect(by(settle, "6-1640")).toBe(5000);
    const ads = mine.filter((j) => j.kind === "ADS" && j.channel === "SHP");
    const adsNet = (a: string) => ads.reduce((s, j) => s + by(j, a), 0);
    expect(adsNet("1-1212")).toBe(-11100);
    expect(adsNet("6-1620")).toBe(1100);
    expect(adsNet("6-1610")).toBe(6000);
    expect(adsNet("1-1222")).toBe(4000);
    const gmv = mine.find((j) => j.kind === "ADS" && j.channel === "TTS")!;
    expect(by(gmv, "6-1611")).toBe(7000);
    expect(by(gmv, "1-1214")).toBe(-7000);
    expect(mine.find((j) => j.kind === "OPEN")).toBeTruthy();

    // neraca saldo bayangan: seimbang; saldo penjual Shopee = pembuka + cair − isi saldo iklan
    const tb = await glTrialBalance({ storeId: st.id, channel: "SHP", to: new Date("2042-12-31") });
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((x) => x.code === "1-1212")!.balance).toBe(200000 + 130000 - 11100);

    // dibangun ulang = hasil sama (idempoten), jurnal nyata tidak berubah
    const r2 = await rebuildGl();
    expect(r2.journals).toBe(r1.journals);
    expect(await prisma.journal.count()).toBe(realBefore);
  });

  it("saran saldo pembuka: Shopee dari file; TikTok manual (tidak ada saran)", async () => {
    const st = await dl();
    expect(await suggestOpening(st.id, "TTS", "PENJUAL", "2026-11-30")).toBeNull();
  });
});
