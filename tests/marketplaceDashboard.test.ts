import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { dashboardData } from "@/lib/marketplace/dashboard";
import { syncStatus, syncVerdict, SYNC_HOUR_KEY, SYNC_START_KEY, sendMarketplaceSyncReminder } from "@/lib/marketplace/sync";
import { alertsFor } from "@/lib/alerts";
import { addDays, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-4).toUpperCase();
const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const at = (d: string) => new Date(`${d}T03:00:00Z`);
async function storeDL() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const ord = (orderNo: string, o: Partial<ParsedOrder>): ParsedOrder => ({ orderNo, orderedAt: at("2037-02-02"), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: "KAB. BOGOR", province: "JAWA BARAT", creatorHandle: null, affiliate: false, subtotal: 0, discount: 0, shippingPaid: 0, total: 10000, refundAmount: 0, returnQty: 0, lines: [{ sku: `DSH${tag}`, variation: null, name: "Produk Dash", qty: 1, unitPrice: 10000, amount: 10000, returnQty: 0 }], ...o });
const file = (platform: "SHOPEE" | "TIKTOK", kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform, kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });
const inc = (refNo: string, released: number, d: string): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at("2037-02-02"), releasedAt: at(d), released, productAmt: released, refundAmt: 0, fees: 0, feeDetail: {} });

describe("Dashboard marketplace", () => {
  it("omzet & pesanan per hari per kanal, cair per hari, top produk/kota; pesanan batal tidak dihitung omzet", async () => {
    const st = await storeDL();
    const rs = await commitImport(actor, [
      { fileName: `dash.shp.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "ORDER", { orders: [ord(`1${num}A`, {}), ord(`1${num}B`, { orderedAt: at("2037-02-03"), total: 30000, lines: [{ sku: `DSH${tag}`, variation: null, name: "Produk Dash", qty: 3, unitPrice: 10000, amount: 30000, returnQty: 0 }] }), ord(`1${num}C`, { rawStatus: "Batal" })] }) },
      { fileName: `dash.tts.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "ORDER", { orders: [ord(`5${num}0000000001`, { total: 20000, city: "Kota Bogor", creatorHandle: `k${tag}`, affiliate: true })] }) },
      { fileName: `dash.inc.${tag}.xlsx`, storeId: st.id, parsed: file("SHOPEE", "INCOME", { incomes: [inc(`1${num}A`, 9000, "2037-02-05")] }) },
    ]);
    for (const r of rs.reverse()) cleanups.push(() => undoImport(actor, r.importId));
    const d = await dashboardData({ month: "2037-02", storeId: st.id });
    expect(d.orders).toBe(3);
    expect(d.batal).toBe(1);
    expect(d.omzet).toBe(60000);
    expect(d.daily).toHaveLength(28);
    expect(d.daily[1]).toMatchObject({ SHP: 10000, TTS: 20000, pesananSHP: 1, pesananTTS: 1 }); // 2 Feb
    expect(d.daily[2]).toMatchObject({ SHP: 30000, pesananSHP: 1 });
    expect(d.daily[4].cair).toBe(9000);
    expect(d.perStore.find((s) => s.channel === "SHP")).toMatchObject({ orders: 2, omzet: 40000, batal: 1 });
    expect(d.perStore.find((s) => s.channel === "TTS")?.affiliate).toBe(1);
    expect(d.topProducts[0]).toMatchObject({ qty: 5, omzet: 50000 }); // dari isi baris pesanan
    expect(d.topCities.find((c) => c.name === "Kab. Bogor")?.orders).toBe(2);
    expect(d.summary.piutangCount).toBe(2); // B & TikTok belum cair; A sudah cair
  });
});

describe("Pembaruan data harian (Supervisor, Owner cadangan)", () => {
  it("penilaian: terlambat 0 = OK, 1 = peringatan, ≥2 = merah; belum pernah = merah/peringatan sejak tanggal mulai", () => {
    expect(syncVerdict("2036-11-20", "2036-11-20", "2036-11-01")).toEqual({ status: "OK", behind: 0 });
    expect(syncVerdict("2036-11-21", "2036-11-20", "2036-11-01").status).toBe("OK");
    expect(syncVerdict("2036-11-19", "2036-11-20", "2036-11-01")).toEqual({ status: "PERINGATAN", behind: 1 });
    expect(syncVerdict("2036-11-17", "2036-11-20", "2036-11-01")).toEqual({ status: "MERAH", behind: 3 });
    expect(syncVerdict(null, "2036-11-20", "2036-11-20").status).toBe("PERINGATAN"); // hari pertama
    expect(syncVerdict(null, "2036-11-22", "2036-11-20").status).toBe("MERAH");
  });

  it("status per toko/kanal/jenis file mengikuti unggahan; jam pengingat menentukan data yang dituntut; alert lonceng hanya Supervisor/Owner/Finance", async () => {
    const st = await storeDL();
    const olds = await prisma.setting.findMany({ where: { key: { in: [SYNC_START_KEY, SYNC_HOUR_KEY] } } });
    cleanups.push(async () => {
      await prisma.setting.deleteMany({ where: { key: { in: [SYNC_START_KEY, SYNC_HOUR_KEY] } } });
      for (const o of olds) await prisma.setting.create({ data: { key: o.key, value: o.value } });
    });
    const today = todayStr();
    // nonaktif selama tanggal mulai belum diatur
    await prisma.setting.deleteMany({ where: { key: SYNC_START_KEY } });
    expect((await syncStatus()).active).toBe(false);
    await prisma.setting.upsert({ where: { key: SYNC_START_KEY }, create: { key: SYNC_START_KEY, value: addDays(today, -5) }, update: { value: addDays(today, -5) } });
    await prisma.setting.upsert({ where: { key: SYNC_HOUR_KEY }, create: { key: SYNC_HOUR_KEY, value: "10" }, update: { value: "10" } });
    const [r] = await commitImport(actor, [{ fileName: `sync.ord.${tag}.xlsx`, storeId: st.id, parsed: file("TIKTOK", "ORDER", { orders: [ord(`6${num}0000000009`, { orderedAt: new Date() })] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const afternoon = new Date(`${today}T08:00:00Z`); // 15.00 WIB → dituntut data hari ini
    const s = await syncStatus(afternoon);
    expect(s).toMatchObject({ active: true, required: today });
    const mine = s.rows.filter((x) => x.storeId === st.id && x.channel === "TTS");
    expect(mine.find((x) => x.kind === "ORDER")).toMatchObject({ status: "OK", lastDate: today });
    expect(mine.find((x) => x.kind === "INCOME")).toMatchObject({ last: null });
    expect(mine.find((x) => x.kind === "INCOME")!.status).not.toBe("OK"); // penghasilan belum pernah diunggah
    expect(s.stale).toBeGreaterThanOrEqual(1);
    // pagi sebelum jam pengingat: yang dituntut baru sampai kemarin
    const morning = new Date(`${today}T00:30:00Z`); // 07.30 WIB
    expect((await syncStatus(morning)).required).toBe(addDays(today, -1));
    // alert lonceng: hanya yang berhak kelola penjualan & pantau produksi
    const can = (p: string) => ["sales.manage", "production.target"].includes(p);
    expect((await alertsFor(can as never)).some((a) => a.key === "mp-sync")).toBe(true);
    expect((await alertsFor(((p: string) => p === "sales.manage") as never)).some((a) => a.key === "mp-sync")).toBe(false);
    // pengingat: tanpa push terkonfigurasi tidak error; tidak ada penerima = 0 perangkat
    const rem = await sendMarketplaceSyncReminder(afternoon, "SUPERVISOR");
    expect(rem.notifikasi).toBe(1);
  });
});
