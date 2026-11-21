import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import { integrityCheck } from "@/lib/marketplace/integrity";
import { coverCell, completeness, mergeIntervals, missingLines, ordersWithoutIncome, incomeGapStores } from "@/lib/marketplace/kelengkapan";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { detectFiles } from "@/lib/marketplace/slots";
import { SYNC_START_KEY } from "@/lib/marketplace/sync";
import JSZip from "jszip";

const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
async function dl() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const order = (orderNo: string, d: string): ParsedOrder => ({ orderNo, orderedAt: at(d), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: null, province: null, creatorHandle: null, affiliate: false, subtotal: 50000, discount: 0, shippingPaid: 0, total: 50000, refundAmount: 0, returnQty: 0, lines: [{ sku: "X", variation: null, name: "X", qty: 1, unitPrice: 50000, amount: 50000 - 0, returnQty: 0 }] });
const file = (kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform: "SHOPEE", kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });
const inc = (refNo: string, d: string): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at(d), releasedAt: at(d), released: 45000, productAmt: 50000, refundAmt: 0, fees: 5000, feeDetail: { "Biaya Administrasi": -5000 } });
const imp = async (storeId: string, channel: string, kind: string, from: string, to: string) => {
  const r = await prisma.marketplaceImport.create({ data: { createdBy: "t", storeId, channel, kind, fileName: `k.${num}.${kind}`, periodFrom: new Date(`${from}T00:00:00Z`), periodTo: new Date(`${to}T00:00:00Z`) } });
  cleanups.push(() => prisma.marketplaceImport.delete({ where: { id: r.id } }));
};

describe("Kelengkapan data per bulan", () => {
  it("cakupan sel: lengkap (dengan toleransi jeda), sebagian, belum ada; rentang bersambung digabung", () => {
    expect(mergeIntervals([["2046-01-01", "2046-01-15"], ["2046-01-16", "2046-01-31"]])).toEqual([["2046-01-01", "2046-01-31"]]);
    expect(coverCell([["2046-01-01", "2046-01-30"]], "2046-01-01", "2046-01-31")).toMatchObject({ status: "OK", through: "2046-01-30" });
    expect(coverCell([["2046-01-01", "2046-01-15"]], "2046-01-01", "2046-01-31")).toMatchObject({ status: "PARTIAL", through: "2046-01-15" });
    expect(coverCell([["2046-02-01", "2046-02-28"]], "2046-01-01", "2046-01-31")).toMatchObject({ status: "MISSING", through: null });
    // dua file per bulan yang saling menyambung = lengkap
    expect(coverCell([["2046-01-01", "2046-01-14"], ["2046-01-15", "2046-01-31"]], "2046-01-01", "2046-01-31").status).toBe("OK");
  });

  it("matriks: ✓/⚠/✗, 'menunggu akses' menjeda sel & pengingat; setelah tanggal tinjau ditagih lagi; teks pengingat", async () => {
    const st = await dl();
    const prevStart = await prisma.setting.findUnique({ where: { key: SYNC_START_KEY } });
    await prisma.setting.upsert({ where: { key: SYNC_START_KEY }, create: { key: SYNC_START_KEY, value: "2046-01-01" }, update: { value: "2046-01-01" } });
    cleanups.push(() => (prevStart ? prisma.setting.update({ where: { key: SYNC_START_KEY }, data: { value: prevStart.value } }) : prisma.setting.deleteMany({ where: { key: SYNC_START_KEY } })));
    await prisma.marketplaceImport.deleteMany({ where: { storeId: st.id, channel: "SHP", fileName: { startsWith: "k." } } });
    await imp(st.id, "SHP", "ORDER", "2046-01-01", "2046-02-28");
    await imp(st.id, "SHP", "INCOME", "2046-01-01", "2046-01-15"); // sebagian Jan, tidak ada Feb
    const now = new Date("2046-03-02T05:00:00Z"); // kemarin = 2046-03-01
    let m = await completeness(now);
    const row = m.rows.find((r) => r.storeId === st.id && r.channel === "SHP")!;
    expect(row.cells["2046-01"].ORDER.status).toBe("OK");
    expect(row.cells["2046-02"].ORDER.status).toBe("OK");
    expect(row.cells["2046-01"].INCOME).toMatchObject({ status: "PARTIAL", through: "2046-01-15" });
    expect(row.cells["2046-02"].INCOME.status).toBe("MISSING");
    expect(row.cells["2046-01"].BALANCE.status).toBe("MISSING");
    expect(m.active).toBe(true);

    // akses Saldo Penjual belum tersedia → menunggu akses (abu-abu), tidak ikut daftar pengingat
    await prisma.marketplaceAccessGap.create({ data: { storeId: st.id, channel: "SHP", kind: "BALANCE", note: "menunggu akses", reviewAt: new Date("2046-03-20T00:00:00Z"), createdBy: "t" } });
    cleanups.push(() => prisma.marketplaceAccessGap.deleteMany({ where: { storeId: st.id } }));
    m = await completeness(now);
    const r2 = m.rows.find((r) => r.storeId === st.id && r.channel === "SHP")!;
    expect(r2.cells["2046-01"].BALANCE.status).toBe("WAIT");
    expect(m.missing.some((x) => x.storeId === st.id && x.kind === "BALANCE")).toBe(false);
    expect(m.missing.some((x) => x.storeId === st.id && x.kind === "INCOME")).toBe(true);
    const lines = missingLines(m.missing.filter((x) => x.storeId === st.id));
    expect(lines.join(" ")).toMatch(/Shopee .*Penghasilan: Jan 46 \(sebagian\), Feb 46/);
    // sesudah tanggal tinjau: ditagih lagi
    const later = await completeness(new Date("2046-03-25T05:00:00Z"));
    expect(later.rows.find((r) => r.storeId === st.id && r.channel === "SHP")!.cells["2046-01"].BALANCE.status).toBe("MISSING");
  });

  it("Piutang tidak bisa divalidasi + Cek Integritas ⚠ saat Penghasilan 'akses belum tersedia'; pesanan >14 hari tanpa penghasilan hanya dari toko yang aksesnya tersedia", async () => {
    const st = await dl();
    const [r] = await commitImport(actor, [{ fileName: `k.o.${num}.xlsx`, storeId: st.id, parsed: file("ORDER", { orders: [order(`${num}K1`, "2046-02-03")] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const now = new Date("2046-03-02T05:00:00Z");
    expect((await ordersWithoutIncome(now)).some((x) => x.storeId === st.id && x.channel === "SHP")).toBe(true);

    await prisma.marketplaceAccessGap.deleteMany({ where: { storeId: st.id, channel: "SHP", kind: "INCOME" } });
    await prisma.marketplaceAccessGap.create({ data: { storeId: st.id, channel: "SHP", kind: "INCOME", note: "akses Penghasilan belum diberikan", reviewAt: new Date("2046-03-20T00:00:00Z"), createdBy: "t" } });
    cleanups.push(() => prisma.marketplaceAccessGap.deleteMany({ where: { storeId: st.id, channel: "SHP", kind: "INCOME" } }));
    expect((await incomeGapStores()).some((g) => g.storeId === st.id && g.channel === "SHP" && g.paused)).toBe(true);
    expect((await ordersWithoutIncome(now)).some((x) => x.storeId === st.id && x.channel === "SHP")).toBe(false); // alert dijeda

    const ic = await integrityCheck({ month: "2046-02", storeId: st.id });
    const k = ic.groups.find((g) => g.channel === "SHP")!.checks.find((c) => c.key === "k")!;
    expect(k).toMatchObject({ ok: false, warn: true });
    expect(k.items!.join(" ")).toMatch(/Piutang tidak bisa divalidasi/);
  });

  it("deteksi toko dari isi: nomor pesanan yang sudah tercatat di toko → toko otomatis (dengan alasan); belum pernah tercatat → pilih toko sekali", async () => {
    const st = await dl();
    const known = `${num}D1`;
    const [r] = await commitImport(actor, [{ fileName: `k.d.${num}.xlsx`, storeId: st.id, parsed: file("ORDER", { orders: [order(known, "2047-02-03")] }) }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const head = ["No. Pesanan", "Status Pesanan", "SKU Induk", "Nama Produk", "Jumlah", "Harga Setelah Diskon", "Subtotal Pesanan", "Total Pembayaran", "Waktu Pesanan Dibuat"];
    const mk = async (nos: string[]) => {
      const zip = new JSZip();
      const rows = [head, ...nos.map((n) => [n, "Selesai", "SKU-X", "X", 1, 50000, 50000, 50000, "2047-02-04 10:00"])];
      const esc = (s: string) => s.replace(/&/g, "&amp;");
      zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
      zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="orders" sheetId="1" r:id="rId1"/></sheets></workbook>`);
      zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
      zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (typeof c === "number" ? `<c r="${String.fromCharCode(65 + ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="inlineStr"><is><t>${esc(String(c))}</t></is></c>`)).join("")}</row>`).join("")}</sheetData></worksheet>`);
      return zip.generateAsync({ type: "nodebuffer" });
    };
    const hit = await detectFiles([{ name: "Order.all.xlsx", buf: await mk([known, `${num}NEWX`]) }]);
    expect(hit[0].storeId).toBe(st.id);
    expect(hit[0].reason).toMatch(/1 dari 2 nomor pesanan sudah tercatat di/);
    const none = await detectFiles([{ name: "Order.all (2).xlsx", buf: await mk([`${num}NEWY`]) }]);
    expect(none[0].needStore).toBe(true);
    expect(none[0].storeId).toBeUndefined();
  });
});
