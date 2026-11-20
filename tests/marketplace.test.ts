import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { makeXlsx } from "./fixtures/xlsxMake";
import { FormatError, parseMarketplaceFile, parseNum } from "@/lib/marketplace/parse";
import { lineKey, mapStatus, normSku, regionCity, shownStatus } from "@/lib/marketplace/rules";
import { commitImport, previewImport, undoImport } from "@/lib/marketplace/import";
import { autoLinkReturn, linkOrdersToReturns } from "@/lib/marketplace/link";
import { resolveSkuKeys } from "@/lib/marketplace/sku";
import { orderSummary, reconcile, regionReport } from "@/lib/marketplace/report";

/** Fixture SINTETIS: header persis format Shopee/TikTok, isi karangan (tidak ada data pembeli asli) */
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const num = Date.now().toString().slice(-7); // ID pesanan TikTok berupa angka
const actor = { id: "t", name: "Tester" };
const NAMA_RAHASIA = "Budi Pembeli Rahasia";
const HP_RAHASIA = "081234567890";

const SHP_HEAD = ["No. Pesanan", "Status Pesanan", "Alasan Pembatalan", "Status Pembatalan/ Pengembalian", "No. Resi", "Opsi Pengiriman", "Waktu Pesanan Dibuat", "Waktu Pembayaran Dilakukan", "Metode Pembayaran", "SKU Induk", "Nama Produk", "Nomor Referensi SKU", "Nama Variasi", "Harga Awal", "Harga Setelah Diskon", "Jumlah", "Returned quantity", "Subtotal Pesanan", "Total Diskon", "Diskon Dari Penjual", "Voucher Ditanggung Penjual", "Ongkos Kirim Dibayar oleh Pembeli", "Total Pembayaran", "Username (Pembeli)", "Nama Penerima", "No. Telepon", "Kota/Kabupaten", "Provinsi", "Waktu Pesanan Selesai"];
const shpRow = (o: Record<string, string | number>) => SHP_HEAD.map((h) => (o[h] ?? null) as string | number | null);
const SHP_ORDERS = [
  // pesanan A: 2 baris produk (satu dengan Nomor Referensi, satu BBWP tanpa referensi)
  shpRow({ "No. Pesanan": `A${tag}1`, "Status Pesanan": "Selesai", "No. Resi": `SPXID${tag}1`, "Opsi Pengiriman": "SPX Standard", "Waktu Pesanan Dibuat": "2026-08-05 10:00", "Metode Pembayaran": "ShopeePay", "SKU Induk": "GBX", "Nama Produk": "Giftbox Mix", "Nomor Referensi SKU": `MG-${tag}MIX`, "Nama Variasi": "Mix", "Harga Awal": "40.000", "Harga Setelah Diskon": "39.000", "Jumlah": 2, "Returned quantity": 0, "Subtotal Pesanan": "88.000", "Total Diskon": "2.000", "Ongkos Kirim Dibayar oleh Pembeli": "5.000", "Total Pembayaran": "88.000", "Nama Penerima": NAMA_RAHASIA, "No. Telepon": HP_RAHASIA, "Username (Pembeli)": "budi_rahasia", "Kota/Kabupaten": "KAB. SIDOARJO", "Provinsi": "Jawa Timur" }),
  shpRow({ "No. Pesanan": `A${tag}1`, "Status Pesanan": "Selesai", "SKU Induk": "BBWP", "Nama Produk": "Extra Packing", "Nama Variasi": "Bubble Wrap", "Harga Awal": 10000, "Harga Setelah Diskon": 10000, "Jumlah": 1, "Subtotal Pesanan": "88.000", "Total Pembayaran": "88.000" }),
  shpRow({ "No. Pesanan": `B${tag}2`, "Status Pesanan": "Batal", "Alasan Pembatalan": "Pembeli batal", "Status Pembatalan/ Pengembalian": "Permintaan Disetujui", "Waktu Pesanan Dibuat": "2026-08-06 09:00", "SKU Induk": "SP", "Nama Produk": "Single Pack", "Nomor Referensi SKU": `SP${tag}`, "Harga Setelah Diskon": 9900, "Jumlah": 3, "Total Pembayaran": "29.700", "Kota/Kabupaten": "KOTA SURABAYA", "Provinsi": "Jawa Timur" }),
  shpRow({ "No. Pesanan": `C${tag}3`, "Status Pesanan": "Selesai", "Status Pembatalan/ Pengembalian": "Pengembalian sedang diproses", "No. Resi": `SPXID${tag}3`, "Opsi Pengiriman": "J&T Express", "Waktu Pesanan Dibuat": "2026-08-07 11:00", "SKU Induk": "SP", "Nama Produk": "Single Pack", "Nomor Referensi SKU": `SP${tag}`, "Harga Setelah Diskon": 9900, "Jumlah": 1, "Returned quantity": 1, "Total Pembayaran": "9.900", "Kota/Kabupaten": "KAB. SIDOARJO", "Provinsi": "Jawa Timur" }),
];
const shopeeOrderFile = () => makeXlsx([{ name: "orders", rows: [SHP_HEAD, ...SHP_ORDERS] }]);

const INC_HEAD = ["No.", "Lihat berdasarkan", "No. Pesanan", "No. Pengajuan", "Waktu Pesanan Dibuat", "Tanggal Dana Dilepaskan", "Metode Pelepasan Dana", "Total Penghasilan", "Harga Produk", "Jumlah Pengembalian Dana ke Pembeli", "Biaya Administrasi", "Biaya Proses Pesanan", "Biaya Transaksi", "Premi", "PPh 22"];
const shopeeIncomeFile = (released = 80000) => makeXlsx([
  { name: "Summary", rows: [["Username (Penjual)", "toko_uji"], ["Periode", "2026-08-01 - 2026-08-31"]] },
  { name: "Penghasilan", rows: [["", "", "Info Pesanan"], ["", "", "Rincian Biaya"], INC_HEAD, [1, "Order", `A${tag}1`, null, "2026-08-05 10:00", "2026-08-12 08:00", "Saldo", released, 88000, 0, "-4000", "-1500", "-2500", "-0", "-0"], [2, "Sku", `A${tag}1`, null, "2026-08-05 10:00", "2026-08-12 08:00", "Saldo", released, 88000, 0, "-4000", "-1500", "-2500", "-0", "-0"]] },
]);

const TT_HEAD = ["Order ID", "Order Status", "Order Substatus", "Cancelation/Return Type", "SKU ID", "Seller SKU", "Product Name", "Variation", "Quantity", "Sku Quantity of return", "SKU Unit Original Price", "SKU Subtotal Before Discount", "SKU Subtotal After Discount", "SKU Seller Discount", "Order Refund Amount", "Order Amount", "Created Time", "Paid Time", "Shipped Time", "Delivered Time", "Cancelled Time", "Cancel By", "Cancel Reason", "Tracking ID", "Delivery Option", "Shipping Provider Name", "Recipient", "Phone #", "Province", "Regency and City", "Payment Method", "Purchase Channel", "Creator Handle"];
const ttRow = (o: Record<string, string | number>) => TT_HEAD.map((h) => (o[h] ?? null) as string | number | null);
const TT_ORDERS = [
  ttRow({ "Order ID": `5781${num}01`, "Order Status": "Selesai", "Seller SKU": `${tag} MIX`, "Product Name": "Giftbox Mix", "Variation": "Mix", "Quantity": 2, "SKU Unit Original Price": 29000, "SKU Subtotal Before Discount": 58000, "SKU Subtotal After Discount": 58000, "Order Amount": 58000, "Created Time": "05/08/2026 10:00:00", "Tracking ID": `TTRES${tag}1`, "Shipping Provider Name": "J&T Express", "Recipient": NAMA_RAHASIA, "Phone #": HP_RAHASIA, "Province": "Jawa Barat", "Regency and City": "Kab. Bekasi", "Payment Method": "Transfer", "Creator Handle": "kreator1" }),
  ttRow({ "Order ID": `5781${num}01`, "Order Status": "Selesai", "Seller SKU": "BWPK", "Product Name": "Bubble Wrap", "Quantity": 1, "SKU Unit Original Price": 3000, "SKU Subtotal After Discount": 3000, "Order Amount": 58000, "Created Time": "05/08/2026 10:00:00" }),
  ttRow({ "Order ID": `5781${num}02`, "Order Status": "Dibatalkan", "Cancelation/Return Type": "Cancel", "Seller SKU": `SP${tag}`, "Quantity": 1, "SKU Unit Original Price": 9900, "SKU Subtotal After Discount": 9900, "Order Amount": 9900, "Created Time": "06/08/2026 08:00:00", "Province": "DKI Jakarta", "Regency and City": "Kota Jakarta Barat" }),
  ttRow({ "Order ID": `5781${num}03`, "Order Status": "Selesai", "Cancelation/Return Type": "Return", "Seller SKU": `SP${tag}`, "Quantity": 1, "Sku Quantity of return": 1, "SKU Unit Original Price": 9900, "SKU Subtotal After Discount": 9900, "Order Refund Amount": 9900, "Order Amount": 9900, "Created Time": "07/08/2026 08:00:00", "Tracking ID": `TTRES${tag}3`, "Province": "Jawa Barat", "Regency and City": "Kab. Bekasi" }),
];
const tiktokOrderFile = (rowPerCell = false) => makeXlsx([{ name: "OrderSKUList", rows: [TT_HEAD, TT_HEAD.map((h) => `Deskripsi ${h}`), ...TT_ORDERS] }], { rowPerCell });

const TI_HEAD = ["ID Pesanan/Penyesuaian", "Jenis transaksi", "Waktu pemesanan", "Waktu pembayaran pesanan", "Jumlah penyelesaian pembayaran", "Total Pendapatan", "Total Biaya", "Biaya komisi platform", "Biaya layanan"];
const tiktokIncomeFile = () => makeXlsx([
  { name: "Laporan", rows: [["ringkasan"]] },
  { name: "Detail pesanan", rows: [TI_HEAD,
    [`5781${num}01`, "Pesanan", "05/08/2026 10:00:00", "12/08/2026 09:00:00", 50000, 58000, -8000, -5000, -3000],
    [`ADS${tag}`, "Pembayaran GMV untuk Iklan TikTok", "10/08/2026 00:00:00", "10/08/2026 00:00:00", -555000, 0, 0, 0, 0],
    [`ADJ${tag}`, "Penyesuaian komisi platform", "11/08/2026 00:00:00", "11/08/2026 00:00:00", 1200, 0, 0, 0, 0]] },
  { name: "Riwayat penarikan", rows: [["Jenis transaksi", "ID referensi", "Waktu permintaan", "Total", "Status", "Waktu keberhasilan", "Rekening bank"], ["Withdrawal", `WD${tag}`, "13/08/2026 10:00:00", -50000, "Berhasil", "14/08/2026 10:00:00", "BCA ****1234"]] },
]);

async function store() {
  const org = await prisma.organization.findFirstOrThrow();
  return (await prisma.store.findUnique({ where: { code: "MG" } })) ?? (await prisma.store.create({ data: { code: "MG", name: "Main Gypsum", organizationId: org.id } }));
}
const rx = new RegExp(`${tag}`);

afterAll(async () => {
  const ids = (await prisma.marketplaceImport.findMany({ where: { fileName: { contains: tag } }, select: { id: true } })).map((i) => i.id);
  await prisma.marketplaceOrder.deleteMany({ where: { importId: { in: ids } } });
  await prisma.marketplaceIncome.deleteMany({ where: { importId: { in: ids } } });
  await prisma.marketplaceWithdrawal.deleteMany({ where: { importId: { in: ids } } });
  await prisma.marketplaceImport.deleteMany({ where: { id: { in: ids } } });
  await prisma.marketplaceSkuMap.deleteMany({ where: { key: { contains: tag } } });
  await prisma.marketplaceSkuClass.deleteMany({ where: { key: { contains: tag } } });
  await prisma.returnCase.deleteMany({ where: { trackingNo: { contains: tag } } });
  await prisma.item.deleteMany({ where: { sku: { startsWith: `MPT-${tag}` } } });
});

describe("Marketplace: aturan murni", () => {
  it("normalisasi SKU: 12 MIX = 12MIX = MG-12MIX", () => {
    expect(normSku("12 MIX")).toBe("12MIX");
    expect(normSku("mg-12mix")).toBe("12MIX");
    expect(normSku("MG-12MIX")).toBe("12MIX");
    expect(lineKey("SHP", "MG-12 MIX", null)).toBe("12MIX|");
    expect(lineKey("SHP", "BBWP", "Bubble Wrap")).toBe("BBWP|BUBBLEWRAP");
    expect(lineKey("TTS", "BBWP", "apa saja")).toBe("BBWP|"); // TikTok: Seller SKU sudah spesifik
  });
  it("nama wilayah diseragamkan antar Shopee/TikTok (mentah tetap disimpan)", () => {
    expect(regionCity("KAB. BOGOR")).toBe("Kab. Bogor");
    expect(regionCity("Kab. Bogor")).toBe("Kab. Bogor");
    expect(regionCity("Kabupaten Bogor")).toBe("Kab. Bogor");
    expect(regionCity("KOTA BEKASI")).toBe("Kota Bekasi");
    expect(regionCity("Kota Bekasi")).toBe("Kota Bekasi");
    expect(regionCity("KOTA JAKARTA TIMUR")).toBe("Kota Jakarta Timur");
    expect(regionCity("Kota Administrasi Jakarta Timur")).toBe("Kota Jakarta Timur");
    expect(regionCity("KOTA ADM. JAKARTA TIMUR")).toBe("Kota Jakarta Timur");
    expect(regionCity("  kab.   tangerang ")).toBe("Kab. Tangerang");
    expect(regionCity(null)).toBe("-");
  });
  it("angka berformat titik ribuan", () => {
    expect(parseNum("64.208")).toBe(64208);
    expect(parseNum("1.234.567")).toBe(1234567);
    expect(parseNum("Rp 9.900")).toBe(9900);
    expect(parseNum(55.5)).toBe(55.5);
    expect(parseNum(null)).toBe(0);
  });
  it("pemetaan status Shopee & TikTok", () => {
    const s = (rawStatus: string, rawReturn: string | null = null) => mapStatus("SHP", { rawStatus, rawReturn, returnQty: 0, refundAmount: 0 });
    expect(s("Selesai")).toBe("PIUTANG");
    expect(s("Sedang Dikirim")).toBe("PIUTANG");
    expect(s("Pesanan diterima, namun Pembeli masih dapat mengajukan pengembalian")).toBe("PIUTANG");
    expect(s("Batal", "Permintaan Disetujui")).toBe("BATAL"); // batal menang atas "disetujui"
    expect(s("Selesai", "Pengembalian sedang diproses")).toBe("RETUR");
    expect(s("Selesai", "Permintaan Disetujui")).toBe("RETUR");
    const t = (rawStatus: string, rawReturn: string | null = null) => mapStatus("TTS", { rawStatus, rawReturn, returnQty: 0, refundAmount: 0 });
    expect(t("Dibatalkan", "Cancel")).toBe("BATAL");
    expect(t("Selesai", "Return")).toBe("RETUR");
    expect(t("Selesai", "Refund")).toBe("RETUR");
    expect(t("Dikirim")).toBe("PIUTANG");
    expect(shownStatus("PIUTANG", true)).toBe("CAIR");
    expect(shownStatus("PIUTANG", false)).toBe("PIUTANG");
    expect(shownStatus("BATAL", true)).toBe("BATAL");
    expect(shownStatus("RETUR", true)).toBe("RETUR");
  });
});

describe("Marketplace: pembaca 4 format", () => {
  it("Shopee Order: dikelompokkan per No. Pesanan, SKU cadangan SKU Induk + Variasi, tanpa data pribadi", async () => {
    const p = await parseMarketplaceFile(await shopeeOrderFile());
    expect(p.platform).toBe("SHOPEE");
    expect(p.kind).toBe("ORDER");
    expect(p.orders).toHaveLength(3);
    const a = p.orders.find((o) => o.orderNo === `A${tag}1`)!;
    expect(a.lines).toHaveLength(2);
    expect(a.total).toBe(88000);
    expect(a.city).toBe("KAB. SIDOARJO");
    expect(a.lines[0].sku).toBe(`MG-${tag}MIX`);
    expect(a.lines[1]).toMatchObject({ sku: "BBWP", variation: "Bubble Wrap", qty: 1 });
    expect(p.orders.find((o) => o.orderNo === `C${tag}3`)!.returnQty).toBe(1);
    const json = JSON.stringify(p);
    expect(json).not.toContain(NAMA_RAHASIA);
    expect(json).not.toContain(HP_RAHASIA);
    expect(json).not.toContain("budi_rahasia");
  });
  it("Shopee Order: nilai pesanan tidak Rp 0 bila kolom total kosong di baris pertama atau semuanya kosong (pakai isi pesanan)", async () => {
    const r1 = shpRow({ "No. Pesanan": `Z1${tag}`, "Status Pesanan": "Selesai", "SKU Induk": "GB", "Nama Produk": "GiftBox", "Nomor Referensi SKU": `GB${tag}`, "Harga Setelah Diskon": 30000, "Jumlah": 1 });
    const r2 = shpRow({ "No. Pesanan": `Z1${tag}`, "Status Pesanan": "Selesai", "SKU Induk": "GB", "Nama Produk": "GiftBox 2", "Nomor Referensi SKU": `GB2${tag}`, "Harga Setelah Diskon": 20000, "Jumlah": 1, "Total Pembayaran": "50.000", "No. Resi": `RS${tag}` });
    const r3 = shpRow({ "No. Pesanan": `Z2${tag}`, "Status Pesanan": "Selesai", "SKU Induk": "GB", "Nama Produk": "GiftBox", "Nomor Referensi SKU": `GB${tag}`, "Harga Setelah Diskon": 30000, "Jumlah": 2 });
    const p = await parseMarketplaceFile(await makeXlsx([{ name: "orders", rows: [SHP_HEAD, r1, r2, r3] }]));
    expect(p.orders.find((o) => o.orderNo === `Z1${tag}`)).toMatchObject({ total: 50000, trackingNo: `RS${tag}` }); // dari baris berikutnya
    expect(p.orders.find((o) => o.orderNo === `Z2${tag}`)!.total).toBe(60000); // dari isi pesanan
  });
  it("Shopee Income: header baris 3, biaya dirinci, username penjual dari Summary", async () => {
    const p = await parseMarketplaceFile(await shopeeIncomeFile());
    expect(p).toMatchObject({ platform: "SHOPEE", kind: "INCOME", info: { seller: "toko_uji" } });
    expect(p.incomes).toHaveLength(1);
    expect(p.incomes[0]).toMatchObject({ refNo: `A${tag}1`, released: 80000, productAmt: 88000, fees: 8000 });
    expect(p.incomes[0].feeDetail["Biaya Administrasi"]).toBe(-4000); // nilai apa adanya (bertanda)
  });
  it("TikTok Order: baris deskripsi dilewati, dikelompokkan per Order ID", async () => {
    const p = await parseMarketplaceFile(await tiktokOrderFile());
    expect(p).toMatchObject({ platform: "TIKTOK", kind: "ORDER" });
    expect(p.orders).toHaveLength(3);
    const a = p.orders.find((o) => o.orderNo === `5781${num}01`)!;
    expect(a.lines).toHaveLength(2);
    expect(a.total).toBe(58000);
    expect(a.creatorHandle).toBe("kreator1");
    expect(JSON.stringify(p)).not.toContain(NAMA_RAHASIA);
    expect(JSON.stringify(p)).not.toContain(HP_RAHASIA);
  });
  it("TikTok Order dengan <row> berulang per sel (file asli): sel digabung, bukan ditimpa", async () => {
    const p = await parseMarketplaceFile(await tiktokOrderFile(true));
    expect(p.orders).toHaveLength(3);
    expect(p.orders.find((o) => o.orderNo === `5781${num}01`)!.lines).toHaveLength(2);
    expect(p.orders.find((o) => o.orderNo === `5781${num}01`)!.total).toBe(58000);
  });
  it("Shopee Income: baris rincian \"Sku\" tidak dihitung dobel", async () => {
    const p = await parseMarketplaceFile(await shopeeIncomeFile());
    expect(p.incomes).toHaveLength(1);
    expect(p.incomes.reduce((a, i) => a + i.released, 0)).toBe(80000);
  });
  it("TikTok Income: pesanan, iklan GMV, penyesuaian, dan riwayat penarikan (tanpa rekening)", async () => {
    const p = await parseMarketplaceFile(await tiktokIncomeFile());
    expect(p).toMatchObject({ platform: "TIKTOK", kind: "INCOME" });
    expect(p.incomes.map((i) => i.kind)).toEqual(["ORDER", "ADS", "ADJUST"]);
    expect(p.incomes[0]).toMatchObject({ released: 50000, fees: 8000 });
    expect(p.withdrawals).toHaveLength(1);
    expect(p.periodFrom).not.toBeNull();
    expect(JSON.stringify(p)).not.toContain("BCA");
  });
  it("format tak dikenal ditolak dengan pesan jelas", async () => {
    await expect(parseMarketplaceFile(await makeXlsx([{ name: "Sheet1", rows: [["a", "b"]] }]))).rejects.toThrow(FormatError);
    await expect(parseMarketplaceFile(Buffer.from("bukan excel"))).rejects.toThrow(/tidak dikenali/);
  });
});

describe("Marketplace: impor ke database", () => {
  it("pratinjau → simpan → ulang identik dilewati → penghasilan mencocokkan → batalkan batch; stok & jurnal tidak tersentuh", async () => {
    const st = await store();
    const [mov0, jur0, tx0] = await Promise.all([prisma.stockMovement.count(), prisma.journal.count(), prisma.financeTransaction.count()]);
    const orderFile = { fileName: `Order.all.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await shopeeOrderFile()) };

    // Penghasilan masuk LEBIH DULU daripada pesanan → disimpan, cocok otomatis nanti
    const incFile = { fileName: `Income.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await shopeeIncomeFile()) };
    const prevInc = await previewImport([incFile]);
    expect(prevInc.files[0]).toMatchObject({ baru: 1, incomeNoOrder: 1 });
    await commitImport(actor, [incFile]);
    expect(await prisma.marketplaceOrder.count({ where: { orderNo: { contains: tag } } })).toBe(0);

    const prev = await previewImport([orderFile]);
    expect(prev.files[0]).toMatchObject({ total: 3, baru: 3, diperbarui: 0, dilewati: 0 });
    expect(prev.files[0].unmapped.map((u) => u.key)).toContain(`${tag}MIX|`); // belum dipetakan
    const [r1] = await commitImport(actor, [orderFile]);
    expect(r1).toMatchObject({ baru: 3, diperbarui: 0, dilewati: 0 });

    const a = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `A${tag}1` }, include: { lines: true, income: true } });
    expect(a.income?.released).toBe(80000n); // tertaut otomatis
    expect(a.lines).toHaveLength(2);
    expect(a.status).toBe("PIUTANG");
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `B${tag}2` } })).status).toBe("BATAL");
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `C${tag}3` } })).status).toBe("RETUR");

    // idempoten
    expect((await previewImport([orderFile])).files[0]).toMatchObject({ baru: 0, diperbarui: 0, dilewati: 3 });
    const [r2] = await commitImport(actor, [orderFile]);
    expect(r2).toMatchObject({ baru: 0, diperbarui: 0, dilewati: 3 });
    expect(await prisma.marketplaceOrder.count({ where: { orderNo: { contains: tag } } })).toBe(3);

    // stok/jurnal/transaksi tidak berubah sama sekali
    expect(await Promise.all([prisma.stockMovement.count(), prisma.journal.count(), prisma.financeTransaction.count()])).toEqual([mov0, jur0, tx0]);

    // nilai berubah di impor berikutnya → diperbarui; batalkan batch itu → kembali
    const changedRows = [...SHP_ORDERS];
    changedRows[0] = shpRow({ ...Object.fromEntries(SHP_HEAD.map((h, i) => [h, SHP_ORDERS[0][i]]).filter(([, v]) => v !== null)) as Record<string, string | number>, "Total Pembayaran": "90.000" });
    const upFile = { fileName: `Order.all.${tag}.v2.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await makeXlsx([{ name: "orders", rows: [SHP_HEAD, ...changedRows] }])) };
    const [r3] = await commitImport(actor, [upFile]);
    expect(r3).toMatchObject({ baru: 0, diperbarui: 1, dilewati: 2 });
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `A${tag}1` } })).total).toBe(90000n);
    await undoImport(actor, r3.importId);
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `A${tag}1` } })).total).toBe(88000n);
    await expect(undoImport(actor, r3.importId)).rejects.toThrow(/sudah dibatalkan/);

    // batalkan batch pesanan awal: pesanan hilang, penghasilan tetap, tautan putus
    await expect(undoImport(actor, r1.importId)).resolves.toBeUndefined();
    expect(await prisma.marketplaceOrder.count({ where: { orderNo: { contains: tag } } })).toBe(0);
    expect(await prisma.marketplaceIncome.count({ where: { refNo: `A${tag}1` } })).toBe(1);
    expect(await Promise.all([prisma.stockMovement.count(), prisma.journal.count(), prisma.financeTransaction.count()])).toEqual([mov0, jur0, tx0]);
  });

  it("TikTok: penghasilan, iklan, penarikan, dan rekonsiliasi per periode", async () => {
    const st = await store();
    const o = await commitImport(actor, [{ fileName: `ttorder.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await tiktokOrderFile()) }, { fileName: `ttincome.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await tiktokIncomeFile()) }]);
    expect(o).toHaveLength(2);
    const a = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `5781${num}01` }, include: { income: true } });
    expect(a.income).toMatchObject({ released: 50000n, fees: 8000n });
    expect(await prisma.marketplaceWithdrawal.count({ where: { refId: `WD${tag}` } })).toBe(1);
    const sum = await orderSummary({ storeId: st.id, channel: "TTS", from: "2026-08-01", to: "2026-08-31", q: tag });
    expect(sum.counts).toMatchObject({ ALL: 3, CAIR: 1, BATAL: 1, RETUR: 1 });
    const rec = await reconcile({ storeId: st.id, from: "2026-08-01", to: "2026-08-31" });
    const tt = rec.find((r) => r.channel === "TTS")!;
    expect(tt.ads).toBeLessThanOrEqual(-555000);
    expect(tt.tiktokWithdraw).toBeGreaterThanOrEqual(50000);
    await undoImport(actor, o[1].importId);
    await undoImport(actor, o[0].importId);
    expect(await prisma.marketplaceWithdrawal.count({ where: { refId: `WD${tag}` } })).toBe(0);
  });
});

describe("Marketplace: SKU & tautan retur", () => {
  it("pemetaan Retur dikenali walau ditulis MG-…; Extra Packing terpisah dari produk", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const item = await prisma.item.create({ data: { sku: `MPT-${tag}`, name: `Produk Uji ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: div.id } });
    await prisma.marketplaceSkuMap.create({ data: { key: `${tag}TEST|`, itemId: item.id, updatedBy: "t" } }); // format yang dipakai Retur
    await prisma.marketplaceSkuClass.create({ data: { key: `BBWP${tag}|BUBBLEWRAP`, kind: "EXTRA_PACKING", variant: "Bubble Wrap", updatedBy: "t" } });
    const res = await resolveSkuKeys([lineKey("SHP", `MG-${tag} TEST`, null), `BBWP${tag}|BUBBLEWRAP`, `TAKADA${tag}|`]);
    expect(res.get(`${tag}TEST|`)).toMatchObject({ kind: "PRODUK", itemId: item.id, by: "PETA" });
    expect(res.get(`BBWP${tag}|BUBBLEWRAP`)).toMatchObject({ kind: "EXTRA_PACKING", variant: "Bubble Wrap" });
    expect(res.has(`TAKADA${tag}|`)).toBe(false);
    expect((await resolveSkuKeys(["BWPK|"])).get("BWPK|")).toMatchObject({ kind: "EXTRA_PACKING", variant: "Extra Dus + Bubble Wrap" });
    // SKU persis sama dengan SKU produk jadi → otomatis (tanpa pemetaan)
    expect((await resolveSkuKeys([`MPT-${tag}|`])).get(`MPT-${tag}|`)).toMatchObject({ kind: "PRODUK", by: "OTOMATIS" });
  });

  it("retur lama ditautkan lewat resi/no. pesanan (data retur tidak diubah); retur baru mengisi kota/provinsi kosong", async () => {
    const st = await store();
    const [r] = await commitImport(actor, [{ fileName: `order.link.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await shopeeOrderFile()) }]);
    const old = await prisma.returnCase.create({ data: { number: `RTR-T${tag}-1`, receivedAt: new Date(), trackingNo: `SPXID${tag}3`, createdBy: "t", city: "Kota Lama" } });
    const fresh = await prisma.returnCase.create({ data: { number: `RTR-T${tag}-2`, receivedAt: new Date(), trackingNo: `SPXID${tag}1`, createdBy: "t" } });
    await linkOrdersToReturns();
    const oc = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: `C${tag}3` } });
    expect(oc.returnCaseId).toBe(old.id);
    expect((await prisma.returnCase.findUniqueOrThrow({ where: { id: old.id } })).city).toBe("Kota Lama"); // tidak diubah
    expect((await prisma.returnCase.findUniqueOrThrow({ where: { id: old.id } })).province).toBeNull();
    await autoLinkReturn("RETUR", fresh.id);
    const f2 = await prisma.returnCase.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(f2).toMatchObject({ city: "KAB. SIDOARJO", province: "Jawa Timur", marketplace: "SHOPEE", storeId: st.id });
    const rep = await regionReport({ storeId: st.id, q: tag });
    expect(rep.total).toBe(2); // pesanan batal tidak dihitung
    expect(rep.cities.find((c) => c.name === "Kab. Sidoarjo")).toMatchObject({ orders: 2, retur: 2 });
    await undoImport(actor, r.importId);
    await prisma.returnCase.deleteMany({ where: { id: { in: [old.id, fresh.id] } } });
  });
});

describe("Marketplace: unggah harian dengan periode tumpang tindih", () => {
  const one = (no: string, o: Record<string, string | number>) => shpRow({ "No. Pesanan": no, "SKU Induk": "SP", "Nama Produk": "Single Pack", "Nomor Referensi SKU": `SP${tag}`, "Harga Setelah Diskon": 9900, "Jumlah": 1, "Total Pembayaran": "9.900", "Waktu Pesanan Dibuat": "2026-09-01 10:00", "Kota/Kabupaten": "KOTA MALANG", "Provinsi": "Jawa Timur", ...o });
  const file = async (name: string, rows: (string | number | null)[][], st: string) => ({ fileName: `${name}.${tag}.xlsx`, storeId: st, parsed: await parseMarketplaceFile(await makeXlsx([{ name: "orders", rows: [SHP_HEAD, ...rows] }])) });

  it("pesanan lama tidak jadi baru: hanya status/resi/batal/retur & pencairan; status tidak mundur; riwayat tercatat", async () => {
    const st = await store();
    const X = `X1${tag}`, Y = `Y1${tag}`;
    const day1 = await file("hari1", [one(X, { "Status Pesanan": "Sedang Dikirim" })], st.id);
    const [d1] = await commitImport(actor, [day1]);
    expect(d1.baru).toBe(1);

    // hari 2: X selesai + resi baru, Y baru
    const day2 = await file("hari2", [one(X, { "Status Pesanan": "Selesai", "No. Resi": `RES${tag}X` }), one(Y, { "Status Pesanan": "Sedang Dikirim" })], st.id);
    const prev = await previewImport([day2]);
    expect(prev.files[0]).toMatchObject({ baru: 1, diperbarui: 1, dilewati: 0 });
    expect(prev.files[0].changes["Sedang Dikirim → Selesai"]).toBe(1);
    expect(prev.files[0].changes["resi baru"]).toBe(1);
    const [d2] = await commitImport(actor, [day2]);
    expect(d2).toMatchObject({ baru: 1, diperbarui: 1 });

    // file lama diunggah lagi: tidak ada yang mundur, tidak ada yang baru
    const [d3] = await commitImport(actor, [day1]);
    expect(d3).toMatchObject({ baru: 0, diperbarui: 0, dilewati: 1 });
    const x = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: X } });
    expect(x).toMatchObject({ rawStatus: "Selesai", trackingNo: `RES${tag}X` });

    // penghasilan masuk → Piutang → Cair (riwayat); lalu file order menyatakan batal setelah cair → perlu dicek, bukan mundur ke piutang
    const inc = { fileName: `inc.${tag}.xlsx`, storeId: st.id, parsed: await parseMarketplaceFile(await makeXlsx([{ name: "Penghasilan", rows: [[], [], INC_HEAD, [1, "Order", X, null, "2026-09-01 10:00", "2026-09-05 08:00", "Saldo", 9000, 9900, 0, "-900", 0, 0, 0, 0]] }])) };
    const pi = await previewImport([inc]);
    expect(pi.files[0].changes["Piutang → Cair"]).toBe(1);
    const [i1] = await commitImport(actor, [inc]);
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: X }, include: { income: true } })).income?.released).toBe(9000n);
    const day3 = await file("hari3", [one(X, { "Status Pesanan": "Batal", "Status Pembatalan/ Pengembalian": "Permintaan Disetujui" })], st.id);
    const [d4] = await commitImport(actor, [day3]);
    expect(d4.diperbarui).toBe(1);
    const x2 = await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: X } });
    expect(x2).toMatchObject({ status: "BATAL", needsCheck: "BATAL_SETELAH_CAIR" });
    // file lama setelah batal tidak menghidupkan lagi
    const [d5] = await commitImport(actor, [day2]);
    expect(d5).toMatchObject({ baru: 0, diperbarui: 0 });
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: X } })).status).toBe("BATAL");

    // riwayat per pesanan
    const hist = await prisma.marketplaceChange.findMany({ where: { rowId: x.id }, orderBy: { createdAt: "asc" } });
    expect(hist.map((h) => h.summary).join(" | ")).toMatch(/Selesai.*resi baru/);
    expect(hist.some((h) => h.summary === "Piutang → Cair")).toBe(true);
    expect(hist.some((h) => /Batal/.test(h.summary ?? ""))).toBe(true);

    // batalkan dari yang terbaru: status kembali; riwayat ringkas tetap ada
    await undoImport(actor, d4.importId);
    expect((await prisma.marketplaceOrder.findFirstOrThrow({ where: { orderNo: X } })).status).toBe("PIUTANG");
    await undoImport(actor, i1.importId);
    await undoImport(actor, d2.importId);
    await undoImport(actor, d1.importId);
    expect(await prisma.marketplaceChange.count({ where: { rowId: x.id, undone: true } })).toBeGreaterThan(0);
  });
});
