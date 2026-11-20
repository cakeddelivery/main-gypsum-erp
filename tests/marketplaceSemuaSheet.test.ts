import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import { integrityCheck } from "@/lib/marketplace/integrity";
import { parseMarketplaceFile } from "@/lib/marketplace/parse";
import { finishJob, runningJob, startJob, stepJob } from "@/lib/marketplace/job";
import { shipDiscrepancyReport } from "@/lib/marketplace/pengeluaran";

const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

type Cell = string | number | null;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const col = (i: number) => String.fromCharCode(65 + i);
/** Bangun .xlsx sintetis (teks inline) — fixture tanpa data asli */
async function xlsx(sheets: Record<string, Cell[][]>) {
  const zip = new JSZip();
  const names = Object.keys(sheets);
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  names.forEach((n, i) => {
    const rows = sheets[n].map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === null ? "" : typeof c === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`)).join("")}</row>`).join("");
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: "nodebuffer" });
}
async function dl() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}

describe("Semua sheet file asli terbaca", () => {
  it("Shopee Income: Selisih ongkir + Seller Fee + Summary + daftar sheet dibaca/dilewati; cek silang Seller Fee; laporan selisih; batal impor", async () => {
    const st = await dl();
    const o1 = `${num}A1`, o2 = `${num}A2`;
    const buf = await xlsx({
      Summary: [["Laporan Penghasilan"], ["Total Pendapatan", 200000], ["Total Pengeluaran", -30000]],
      Penghasilan: [
        ["Laporan"], ["No.", "No. Pesanan", "Lihat Berdasarkan", "Waktu Pesanan Dibuat", "Tanggal Dana Dilepaskan", "Total Penghasilan", "Harga Produk", "Jumlah Pengembalian Dana ke Pembeli", "Biaya Administrasi", "Biaya Proses Pesanan"],
        [1, o1, "Order", "2040-05-02 10:00", "2040-05-10 10:00", 90000, 100000, 0, -8000, -2000],
        [2, o2, "Order", "2040-05-03 10:00", "2040-05-10 11:00", 95000, 100000, 0, -4000, -1000],
      ],
      "Shipping Fee Discrepancy": [
        ["Catatan: selisih ongkos kirim"],
        ["No. Pesanan", "Estimasi Ongkos Kirim:", "Ongkos Kirim yang Dibayarkan ke Jasa Kirim:", "Discrepancy reason"],
        [o1, 10000, 16000, "Berat/dimensi aktual melebihi informasi berat/dimensi produk"],
        [o2, 10000, 12000, "Penjual mengubah alamat penjemputan atau drop off."],
      ],
      "Seller Fee": [
        ["Catatan"], ["No.", "No. Pesanan", "Biaya Platform", "Biaya Gratis Ongkir XTRA", "Biaya Layanan", "Biaya Promosi", "Biaya Lainnya"],
        [1, o1, 8000, 0, 2000, 0, 0], // = 10.000 (cocok)
        [2, o2, 4000, 0, 0, 0, 500], // = 4.500 vs potongan 5.000 → selisih
      ],
      Adjustment: [["Ringkasan penyesuaian", 0]],
    });
    const p = await parseMarketplaceFile(buf);
    expect(p.kind).toBe("INCOME");
    expect(p.shipDiscrepancies).toHaveLength(2);
    expect(p.shipDiscrepancies![0]).toMatchObject({ orderNo: o1, estimate: 10000, paid: 16000, diff: 6000 });
    expect(p.shipDiscrepancies![0].reason).toMatch(/berat\/dimensi/i);
    expect(p.sellerFees).toHaveLength(2);
    expect(p.sellerFees![1]).toMatchObject({ orderNo: o2, platformFee: 4000, other: 500 });
    expect(p.info.sheets?.read).toEqual(expect.arrayContaining(["Penghasilan", "Summary", "Shipping Fee Discrepancy", "Seller Fee"]));
    expect(p.info.sheets?.skipped.map((x) => x.name)).toEqual(["Adjustment"]);
    expect(p.info.summaryRows?.map((r) => r.label)).toEqual(expect.arrayContaining(["Total Pendapatan", "Total Pengeluaran"]));

    const [r] = await commitImport(actor, [{ fileName: `inc.${num}.xlsx`, storeId: st.id, parsed: p }]);
    cleanups.push(() => undoImport(actor, r.importId));
    expect(await prisma.marketplaceShipDiscrepancy.count({ where: { storeId: st.id, orderNo: { in: [o1, o2] } } })).toBe(2);

    // impor ulang identik: tidak dobel
    const again = await commitImport(actor, [{ fileName: `inc2.${num}.xlsx`, storeId: st.id, parsed: p }]);
    expect(again[0].importId).toBe("");
    expect(await prisma.marketplaceSellerFee.count({ where: { storeId: st.id, orderNo: { in: [o1, o2] } } })).toBe(2);

    // laporan selisih ongkir (Mei 2040): 6.000 + 2.000, alasan dikelompokkan
    const rep = await shipDiscrepancyReport({ month: "2040-05", storeId: st.id, channel: "SHP" });
    expect(rep).toMatchObject({ count: 2, value: 8000 });
    expect(rep!.reasons).toHaveLength(2);

    // cek silang: pesanan 2 berbeda (Seller Fee 4.500 vs potongan 5.000)
    const ic = await integrityCheck({ month: "2040-05", storeId: st.id });
    const j = ic.groups.find((g) => g.channel === "SHP")!.checks.find((c) => c.key === "j")!;
    expect(j.ok).toBe(false);
    expect(j.items!.join(" ")).toContain(o2);
    expect(j.items!.join(" ")).not.toContain(o1);

    await undoImport(actor, r.importId);
    cleanups.pop();
    expect(await prisma.marketplaceShipDiscrepancy.count({ where: { storeId: st.id, orderNo: { in: [o1, o2] } } })).toBe(0);
    expect(await prisma.marketplaceSellerFee.count({ where: { storeId: st.id, orderNo: { in: [o1, o2] } } })).toBe(0);
  });

  it("File Order Shopee: semua kolom non-pribadi tersimpan per baris; data pribadi tidak; lengkapi pesanan lama", async () => {
    const st = await dl();
    const no = `${num}B1`;
    const header = ["No. Pesanan", "Status Pesanan", "SKU Induk", "Nama Produk", "Jumlah", "Harga Setelah Diskon", "Subtotal Pesanan", "Total Pembayaran", "Berat Produk (gram)", "Voucher Ditanggung Penjual", "Cashback Koin", "Perkiraan Ongkos Kirim", "Username (Pembeli)", "Nama Penerima", "No. Telepon", "Alamat Pengiriman", "Kota/Kabupaten", "Provinsi", "Catatan dari Pembeli", "Waktu Pesanan Dibuat"];
    const buf = await xlsx({ orders: [header, [no, "Selesai", "SKU-X", "Gypsum X", 2, 50000, 100000, 100000, 750, 5000, 1000, 9000, "budi123", "Budi Santoso", "08123456789", "Jl. Mawar 1 RT 2", "KAB. BOGOR", "JAWA BARAT", "tolong bungkus rapi", "2040-05-02 10:00"]] });
    const p = await parseMarketplaceFile(buf);
    const ex = p.orders[0].extra![0];
    expect(ex).toMatchObject({ "Berat Produk (gram)": 750, "Voucher Ditanggung Penjual": 5000, "Cashback Koin": 1000, "Perkiraan Ongkos Kirim": 9000 });
    const blob = JSON.stringify(ex);
    for (const bad of ["budi123", "Budi Santoso", "08123456789", "Mawar", "bungkus"]) expect(blob).not.toContain(bad);
    expect(p.info.personalCols).toEqual(expect.arrayContaining(["Username (Pembeli)", "Nama Penerima", "No. Telepon", "Alamat Pengiriman", "Catatan dari Pembeli"]));
    expect(p.info.personalCols).not.toContain("Kota/Kabupaten");

    // pesanan lama tanpa kolom lengkap: unggah ulang melengkapi
    const [r] = await commitImport(actor, [{ fileName: `ord.${num}.xlsx`, storeId: st.id, parsed: p }]);
    cleanups.push(() => undoImport(actor, r.importId));
    const row = await prisma.marketplaceOrder.findFirstOrThrow({ where: { storeId: st.id, channel: "SHP", orderNo: no } });
    expect(JSON.stringify(row.extra)).toContain("Cashback Koin");
    await prisma.marketplaceOrder.update({ where: { id: row.id }, data: { extra: undefined } });
    await prisma.$executeRaw`UPDATE "MarketplaceOrder" SET "extra" = NULL WHERE "id" = ${row.id}`;
    await commitImport(actor, [{ fileName: `ord2.${num}.xlsx`, storeId: st.id, parsed: p }]);
    const after = await prisma.marketplaceOrder.findUniqueOrThrow({ where: { id: row.id } });
    expect(JSON.stringify(after.extra)).toContain("Cashback Koin");
  });

  it("Proses impor: banner aktif selama berjalan, hilang saat selesai atau macet >15 menit", async () => {
    await prisma.marketplaceImportJob.deleteMany({ where: { createdBy: "Tester-job" } });
    const j = await startJob({ name: "Tester-job" }, 2, "a.xlsx");
    cleanups.push(() => prisma.marketplaceImportJob.deleteMany({ where: { createdBy: "Tester-job" } }));
    expect(await runningJob()).toMatchObject({ id: j.id, total: 2, done: 0 });
    await stepJob(j.id, 1, "a.xlsx ✓");
    expect((await runningJob())?.done).toBe(1);
    await finishJob(j.id, true, "selesai");
    expect(await runningJob()).toBeNull();
    const old = await startJob({ name: "Tester-job" }, 1, "b");
    await prisma.marketplaceImportJob.update({ where: { id: old.id }, data: { updatedAt: new Date(Date.now() - 20 * 60000) } });
    expect(await runningJob()).toBeNull(); // macet → bukan "sedang diproses"
  });
});
