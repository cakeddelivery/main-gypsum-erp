import { createHash } from "node:crypto";
import { defaultCategory, looksLikeFee } from "./feeMap";
import { readXlsx, XlsxError, type Cell, type Sheet } from "./xlsx";

/**
 * Pembaca file Excel Shopee & TikTok Shop (murni, tanpa database). Deteksi dari NAMA SHEET + HEADER, bukan nama file.
 * DATA PRIBADI: nama/telepon/alamat/catatan pembeli, rekening bank TIDAK dibaca ke hasil.
 */
export type Platform = "SHOPEE" | "TIKTOK";
export type FileKind = "ORDER" | "INCOME" | "BALANCE" | "ADSBILL";

export type ParsedLine = { sku: string | null; variation: string | null; name: string | null; qty: number; unitPrice: number; amount: number; returnQty: number };
export type ParsedOrder = {
  orderNo: string;
  orderedAt: Date | null;
  paidAt: Date | null;
  completedAt: Date | null;
  rawStatus: string | null;
  rawSubstatus: string | null;
  rawReturn: string | null;
  cancelReason: string | null;
  trackingNo: string | null;
  shipOption: string | null;
  courier: string | null;
  paymentMethod: string | null;
  city: string | null;
  province: string | null;
  creatorHandle: string | null;
  /** Penanda affiliate dari file order (TikTok: kreator terisi) */
  affiliate: boolean;
  subtotal: number;
  discount: number;
  shippingPaid: number;
  total: number;
  refundAmount: number;
  returnQty: number;
  lines: ParsedLine[];
  /** Semua kolom NON-pribadi dari file Order, satu objek per baris produk (nama kolom → nilai) */
  extra?: Record<string, string | number>[];
};
/** Selisih ongkir Shopee (sheet "Shipping Fee Discrepancy") */
export type ParsedShipDisc = { orderNo: string; estimate: number; paid: number; diff: number; reason: string | null; date: Date | null };
/** Rincian "Seller Fee" Shopee per pesanan */
export type ParsedSellerFee = { orderNo: string; platformFee: number; xtra: number; service: number; promo: number; other: number };
export type ParsedIncome = {
  /// ORDER · ADS (potongan GMV iklan TikTok, langsung dari saldo) · ADJUST (penyesuaian) · TOPUP (isi saldo iklan Shopee, mengurangi saldo penjual) · ADSUSE (mutasi saldo iklan Shopee: pemakaian = biaya iklan)
  kind: "ORDER" | "ADS" | "ADJUST" | "TOPUP" | "ADSUSE";
  refNo: string;
  orderedAt: Date | null;
  releasedAt: Date | null;
  released: number;
  productAmt: number;
  refundAmt: number;
  fees: number;
  feeDetail: Record<string, number>;
};
/** Satu mutasi di Buku Saldo Penjual Shopee */
export type ParsedBalanceTx = { txKey: string; date: Date; type: string; description: string | null; orderNo: string | null; amount: number; status: string | null; balanceAfter: number | null; pos: number; category: string };
export type ParsedWithdrawal = { txType: string; refId: string; requestedAt: Date | null; doneAt: Date | null; amount: number; status: string | null };
export type ParsedFile = {
  platform: Platform;
  kind: FileKind;
  orders: ParsedOrder[];
  incomes: ParsedIncome[];
  withdrawals: ParsedWithdrawal[];
  /** Hanya file Buku Saldo Penjual */
  balanceTx?: ParsedBalanceTx[];
  shipDiscrepancies?: ParsedShipDisc[];
  sellerFees?: ParsedSellerFee[];
  periodFrom: Date | null;
  periodTo: Date | null;
  /** Info tampilan (mis. username penjual dari sheet Summary Shopee) */
  info: { seller?: string; rows: number; /** Sheet yang dibaca / dilewati (dengan alasan) & kolom yang sengaja tidak disimpan (data pribadi) */ sheets?: { read: string[]; skipped: { name: string; reason: string }[] }; personalCols?: string[]; /** Semua baris sheet Summary (label → angka) */ summaryRows?: { label: string; value: number }[]; /** Keterangan tambahan untuk pratinjau (mis. ringkasan Saldo Penjual) */ note?: string; /** Total ringkasan di file (Shopee Summary / TikTok Laporan) untuk cek integritas */ summaryTotal?: number; summaryLabel?: string };
};

export class FormatError extends Error {}

const WIB = 7 * 3600 * 1000;
const str = (c: Cell | undefined): string | null => {
  if (c === null || c === undefined) return null;
  const s = String(c).trim();
  return s === "" || s === "-" ? null : s;
};

/** "64.208" (titik ribuan) / "64208" / number / "Rp 1.234,50" → angka */
export function parseNum(c: Cell | undefined): number {
  if (c === null || c === undefined) return 0;
  if (typeof c === "number") return c;
  let s = String(c).replace(/rp/gi, "").replace(/\s/g, "");
  if (!s || s === "-") return 0;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Tanggal "2026-08-28 14:30", "28/08/2026 14:30:12", atau serial Excel; waktu dianggap WIB */
export function parseDate(c: Cell | undefined): Date | null {
  if (c === null || c === undefined || c === "") return null;
  if (typeof c === "number") return c > 20000 ? new Date(Math.round((c - 25569) * 86400000) - WIB) : null;
  const s = String(c).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - WIB);
  m = /^(\d{4})\/(\d{2})\/(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - WIB);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - WIB);
  return null;
}

const norm = (s: Cell | undefined) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Peta nama kolom → indeks dari satu baris header */
function headerMap(row: Cell[]) {
  const m = new Map<string, number>();
  row.forEach((c, i) => {
    const k = norm(c);
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}
const need = (h: Map<string, number>, ...names: string[]) => {
  for (const n of names) {
    const i = h.get(n.toLowerCase());
    if (i !== undefined) return i;
  }
  return -1;
};
const findHeaderRow = (rows: Cell[][], marker: string, maxRow = 8) => {
  for (let r = 0; r < Math.min(rows.length, maxRow); r++) if ((rows[r] ?? []).some((c) => norm(c) === marker)) return r;
  return -1;
};
const sheetOf = (sheets: Sheet[], name: string) => sheets.find((s) => norm(s.name) === name.toLowerCase());
const clean = (s: string | null, max = 120) => (s ? s.replace(/\s+/g, " ").slice(0, max) : null);

const minMax = (ds: (Date | null)[]) => {
  const xs = ds.filter((d): d is Date => !!d).map((d) => d.getTime());
  return xs.length ? { from: new Date(Math.min(...xs)), to: new Date(Math.max(...xs)) } : { from: null, to: null };
};

/** Cari nilai di sebelah kanan sel berlabel (untuk sheet ringkasan); label dicocokkan longgar */
function labelValue(sheet: Sheet | undefined, re: RegExp): { label: string; value: number } | null {
  for (const row of sheet?.rows ?? []) {
    for (let i = 0; i < (row?.length ?? 0); i++) {
      const c = row[i];
      if (typeof c !== "string" || !re.test(c.trim().toLowerCase())) continue;
      for (const v of row.slice(i + 1)) {
        if (v === null || v === "") continue;
        const num = typeof v === "number" ? v : parseNum(v);
        if (typeof v === "number" || /\d/.test(String(v))) return { label: c.trim(), value: num };
      }
    }
  }
  return null;
}
const textRight = (sheet: Sheet | undefined, re: RegExp): string | undefined => {
  for (const row of sheet?.rows ?? []) {
    const i = (row ?? []).findIndex((c) => re.test(String(c ?? "").trim().toLowerCase()));
    if (i >= 0) return (row.slice(i + 1).map(str).find(Boolean) as string | undefined) ?? undefined;
  }
  return undefined;
};

/** Kolom berisi data pribadi pembeli/penerima: TIDAK disimpan (kolom wilayah kota/provinsi sudah disimpan terpisah) */
const PERSONAL_RE = /username|nama penerima|nama pembeli|penerima|pembeli.*nama|telepon|telp|phone|alamat|address|kode ?pos|zip|postal|catatan|note|message|pesan dari|buyer|recipient|email|\bnik\b|ktp|kecamatan|kelurahan|district|village|desa|rekening|bank account|account no/;
/** Pengecualian: kolom "ongkos kirim dibayar oleh pembeli", dst. bukan data pribadi */
const NOT_PERSONAL_RE = /dibayar oleh pembeli|paid by buyer|buyer paid|buyer service fee|biaya.*pembeli|pembeli.*biaya|diskon|subtotal|jumlah|total|voucher/;
export const isPersonalCol = (name: string) => { const k = name.toLowerCase(); return PERSONAL_RE.test(k) && !NOT_PERSONAL_RE.test(k); };
/** Satu baris file Order → semua kolom non-pribadi yang terisi */
function rawRow(header: Cell[], r: Cell[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  header.forEach((c, i) => {
    const k = String(c ?? "").trim();
    const v = r?.[i];
    if (!k || v === null || v === undefined || v === "" || k in out || isPersonalCol(k)) return;
    out[k.slice(0, 60)] = typeof v === "number" ? v : String(v).replace(/\s+/g, " ").slice(0, 100);
  });
  return out;
}
const personalCols = (header: Cell[]) => [...new Set(header.map((c) => String(c ?? "").trim()).filter((k) => k && isPersonalCol(k)))];

// ---------- 1) Shopee Order.all ----------
function parseShopeeOrders(sh: Sheet): ParsedFile {
  const hr = findHeaderRow(sh.rows, "no. pesanan", 3);
  if (hr < 0) throw new FormatError("Kolom “No. Pesanan” tidak ditemukan di sheet orders");
  const h = headerMap(sh.rows[hr]);
  const c = (...n: string[]) => need(h, ...n);
  const I = {
    no: c("no. pesanan"), status: c("status pesanan"), cancelReason: c("alasan pembatalan"), ret: c("status pembatalan/ pengembalian", "status pembatalan/pengembalian"),
    resi: c("no. resi"), ship: c("opsi pengiriman"), created: c("waktu pesanan dibuat"), paid: c("waktu pembayaran dilakukan"), pay: c("metode pembayaran"),
    skuInduk: c("sku induk"), name: c("nama produk"), ref: c("nomor referensi sku"), variation: c("nama variasi"), price: c("harga awal"), priceAfter: c("harga setelah diskon"),
    qty: c("jumlah"), retQty: c("returned quantity"), subtotal: c("subtotal pesanan"), disc: c("total diskon"), shipFee: c("ongkos kirim dibayar oleh pembeli"),
    total: c("total pembayaran"), city: c("kota/kabupaten"), prov: c("provinsi"), done: c("waktu pesanan selesai"),
  };
  if (I.no < 0 || I.skuInduk < 0) throw new FormatError("Header sheet orders tidak sesuai format Shopee “Order.all”");
  const byNo = new Map<string, ParsedOrder>();
  let rows = 0;
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[I.no]);
    if (!no) continue;
    rows++;
    let o = byNo.get(no);
    if (!o) {
      const ship = clean(str(r[I.ship]), 60);
      o = {
        orderNo: no, orderedAt: parseDate(r[I.created]), paidAt: parseDate(r[I.paid]), completedAt: parseDate(r[I.done]),
        rawStatus: clean(str(r[I.status]), 200), rawSubstatus: null, rawReturn: clean(str(r[I.ret]), 120), cancelReason: clean(str(r[I.cancelReason]), 200),
        trackingNo: clean(str(r[I.resi]), 60)?.toUpperCase() ?? null, shipOption: ship, courier: ship ? ship.split(/[\s-]/)[0] : null, paymentMethod: clean(str(r[I.pay]), 60),
        city: clean(str(r[I.city]), 60), province: clean(str(r[I.prov]), 60), creatorHandle: null, affiliate: false,
        subtotal: parseNum(r[I.subtotal]), discount: parseNum(r[I.disc]), shippingPaid: parseNum(r[I.shipFee]), total: parseNum(r[I.total]), refundAmount: 0, returnQty: 0, lines: [],
      };
      byNo.set(no, o);
    }
    // kolom tingkat-pesanan bisa kosong di baris pertama: lengkapi dari baris berikutnya
    if (!o.total) o.total = parseNum(r[I.total]);
    if (!o.subtotal) o.subtotal = parseNum(r[I.subtotal]);
    if (!o.discount) o.discount = parseNum(r[I.disc]);
    if (!o.shippingPaid) o.shippingPaid = parseNum(r[I.shipFee]);
    o.trackingNo ??= clean(str(r[I.resi]), 60)?.toUpperCase() ?? null;
    const qty = Math.round(parseNum(r[I.qty]));
    const unit = parseNum(r[I.priceAfter]) || parseNum(r[I.price]);
    const retQty = Math.round(parseNum(r[I.retQty]));
    // SKU: Nomor Referensi SKU; bila kosong pakai SKU Induk (varian dibedakan lewat Nama Variasi)
    const ref = str(r[I.ref]);
    (o.extra ??= []).push(rawRow(sh.rows[hr], r));
    o.lines.push({ sku: ref ?? str(r[I.skuInduk]), variation: ref ? null : clean(str(r[I.variation]), 80), name: clean(str(r[I.name]), 120), qty, unitPrice: unit, amount: Math.round(qty * unit), returnQty: retQty });
    o.returnQty += retQty;
  }
  const orders = [...byNo.values()];
  for (const o of orders) if (!o.total) o.total = o.subtotal || o.lines.reduce((a, l) => a + l.amount, 0); // nilai pesanan tidak boleh Rp 0 bila ada isinya
  const { from, to } = minMax(orders.map((o) => o.orderedAt));
  return { platform: "SHOPEE", kind: "ORDER", orders, incomes: [], withdrawals: [], periodFrom: from, periodTo: to, info: { rows, personalCols: personalCols(sh.rows[hr]) } };
}

// ---------- 2) Shopee Income (sheet Penghasilan) ----------
function parseShopeeIncome(sheets: Sheet[], sh: Sheet): ParsedFile {
  const hr = findHeaderRow(sh.rows, "no. pesanan", 6);
  if (hr < 0) throw new FormatError("Kolom “No. Pesanan” tidak ditemukan di sheet Penghasilan");
  const h = headerMap(sh.rows[hr]);
  const I = {
    no: need(h, "no. pesanan"), created: need(h, "waktu pesanan dibuat"), rel: need(h, "tanggal dana dilepaskan"), total: need(h, "total penghasilan"),
    view: need(h, "lihat berdasarkan"), prod: need(h, "harga produk"), refund: need(h, "jumlah pengembalian dana ke pembeli"),
  };
  if (I.no < 0 || I.total < 0) throw new FormatError("Header sheet Penghasilan tidak sesuai format Shopee “Income”");
  // Semua kolom yang tampak seperti komponen biaya disimpan APA ADANYA (bertanda) agar tidak ada potongan yang hilang
  const skip = new Set([I.no, I.view, I.created, I.rel, I.total, I.prod, need(h, "no."), need(h, "no. pengajuan"), need(h, "metode pelepasan dana")]);
  const feeCols = (sh.rows[hr] ?? []).map((c, i) => ({ k: String(c ?? "").trim(), i })).filter((x) => x.k && !skip.has(x.i) && looksLikeFee(x.k, "SHOPEE"));
  const incomes: ParsedIncome[] = [];
  let rows = 0;
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[I.no]);
    if (!no || !/\d/.test(no)) continue;
    // File asli memuat dua jenis baris: "Order" (satu per pesanan) dan "Sku" (rincian per produk). Hanya "Order" dihitung agar tidak dobel.
    if (I.view >= 0 && norm(r[I.view]) !== "order") continue;
    rows++;
    const feeDetail: Record<string, number> = {};
    let fees = 0;
    for (const { k, i } of feeCols) {
      const v = Math.round(parseNum(r[i]));
      if (!v || k in feeDetail) continue; // nama kolom sama muncul lagi (grup info pembeli): hanya yang pertama
      feeDetail[k] = v;
      const c = defaultCategory(k, "SHOPEE");
      if (["ADMIN", "PROSES", "ONGKIR_PROGRAM", "AFFILIATE", "ASURANSI", "LAYANAN", "PAJAK"].includes(c)) fees += Math.abs(v);
    }
    incomes.push({ kind: "ORDER", refNo: no, orderedAt: parseDate(r[I.created]), releasedAt: parseDate(r[I.rel]), released: Math.round(parseNum(r[I.total])), productAmt: Math.round(parseNum(r[I.prod])), refundAmt: Math.round(Math.abs(parseNum(r[I.refund]))), fees: Math.round(fees), feeDetail });
  }
  // Summary: username penjual + total ringkasan (untuk cek integritas)
  const sum = sheetOf(sheets, "summary");
  let seller: string | undefined;
  let summaryTotal: number | undefined;
  let summaryLabel: string | undefined;
  try {
    seller = textRight(sum, /username|nama pengguna/);
    const direct = labelValue(sum, /^total penghasilan$/);
    if (direct) ({ value: summaryTotal, label: summaryLabel } = direct);
    else {
      const inc = labelValue(sum, /^total pendapatan$/);
      const out = labelValue(sum, /^total pengeluaran$/);
      if (inc && out) {
        summaryTotal = inc.value - Math.abs(out.value);
        summaryLabel = "Total Pendapatan − Total Pengeluaran";
      }
    }
  } catch {
    /* info saja */
  }
  // Sheet "Adjustment": hanya informasi. Penyesuaian saldo masuk lewat file Buku Saldo Penjual (menghindari hitung ganda).
  let note: string | undefined;
  const adj = sheetOf(sheets, "adjustment");
  if (adj) {
    const n = adj.rows.filter((r) => (r ?? []).some((c) => typeof c === "number" && c !== 0)).length;
    note = `Sheet Adjustment (${n} baris) tidak dihitung dari file ini; penyesuaian saldo dibaca dari file “Transaksi Saldo Penjual”.`;
  }
  const { from, to } = minMax(incomes.map((x) => x.releasedAt ?? x.orderedAt));
  const dateOf = new Map(incomes.map((x) => [x.refNo, x.releasedAt ?? x.orderedAt]));
  const shipDiscrepancies = parseShipDiscrepancy(sheetOf(sheets, "shipping fee discrepancy"), dateOf);
  const sellerFees = parseSellerFee(sheetOf(sheets, "seller fee"));
  const summaryRows = summaryList(sum);
  const read = [sh.name, ...(sum ? [sum.name] : []), ...(shipDiscrepancies.length || sheetOf(sheets, "shipping fee discrepancy") ? ["Shipping Fee Discrepancy"] : []), ...(sellerFees.length || sheetOf(sheets, "seller fee") ? ["Seller Fee"] : [])];
  const skipped = sheets.filter((x) => !read.includes(x.name)).map((x) => ({ name: x.name, reason: norm(x.name) === "adjustment" ? "ringkasan (penyesuaian saldo dibaca dari file Saldo Penjual, agar tidak dobel)" : "tidak dipakai" }));
  return { platform: "SHOPEE", kind: "INCOME", orders: [], incomes, withdrawals: [], periodFrom: from, periodTo: to, shipDiscrepancies, sellerFees, info: { seller, rows, note, summaryTotal, summaryLabel, summaryRows, sheets: { read, skipped } } };
}

/** Sheet "Shipping Fee Discrepancy": baris 1 catatan, header baris 2 (No. Pesanan | Estimasi Ongkos Kirim | Ongkos Kirim yang Dibayarkan ke Jasa Kirim | Discrepancy reason) */
function parseShipDiscrepancy(sh: Sheet | undefined, dateOf: Map<string, Date | null>): ParsedShipDisc[] {
  if (!sh) return [];
  const hr = findHeaderRow(sh.rows, "no. pesanan", 6);
  if (hr < 0) return [];
  const h = headerMap(sh.rows[hr]);
  const est = [...h.keys()].find((k) => k.startsWith("estimasi ongkos kirim"));
  const paid = [...h.keys()].find((k) => k.startsWith("ongkos kirim yang dibayarkan"));
  const why = [...h.keys()].find((k) => k.includes("discrepancy reason") || k.includes("alasan"));
  const iNo = h.get("no. pesanan")!, iEst = est ? h.get(est)! : -1, iPaid = paid ? h.get(paid)! : -1, iWhy = why ? h.get(why)! : -1;
  if (iEst < 0 || iPaid < 0) return [];
  const out = new Map<string, ParsedShipDisc>();
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[iNo]);
    if (!no || !/\d/.test(no)) continue;
    const e = Math.round(parseNum(r[iEst])), p = Math.round(parseNum(r[iPaid]));
    out.set(no, { orderNo: no, estimate: e, paid: p, diff: p - e, reason: iWhy >= 0 ? clean(str(r[iWhy]), 200) : null, date: dateOf.get(no) ?? null });
  }
  return [...out.values()];
}

/** Sheet "Seller Fee": No. | No. Pesanan | Biaya Platform | Biaya Gratis Ongkir XTRA | Biaya Layanan | Biaya Promosi | Biaya Lainnya */
function parseSellerFee(sh: Sheet | undefined): ParsedSellerFee[] {
  if (!sh) return [];
  const hr = findHeaderRow(sh.rows, "no. pesanan", 6);
  if (hr < 0) return [];
  const h = headerMap(sh.rows[hr]);
  const col = (re: RegExp) => { const k = [...h.keys()].find((x) => re.test(x)); return k ? h.get(k)! : -1; };
  const I = { no: h.get("no. pesanan")!, platform: col(/^biaya platform/), xtra: col(/xtra|gratis ongkir/), service: col(/^biaya layanan/), promo: col(/^biaya promosi/), other: col(/^biaya lainnya/) };
  const v = (r: Cell[], i: number) => (i < 0 ? 0 : Math.round(Math.abs(parseNum(r[i]))));
  const out = new Map<string, ParsedSellerFee>();
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[I.no]);
    if (!no || !/\d/.test(no)) continue;
    out.set(no, { orderNo: no, platformFee: v(r, I.platform), xtra: v(r, I.xtra), service: v(r, I.service), promo: v(r, I.promo), other: v(r, I.other) });
  }
  return [...out.values()];
}

/** Semua baris ringkasan sheet Summary (label + angka pertama di kanannya) */
function summaryList(sum: Sheet | undefined): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  for (const row of sum?.rows ?? []) {
    const i = (row ?? []).findIndex((c) => typeof c === "string" && c.trim() && !/^[\d.,\s-]+$/.test(c));
    if (i < 0) continue;
    const label = String(row[i]).trim().slice(0, 80);
    const val = row.slice(i + 1).find((c) => typeof c === "number" || (typeof c === "string" && /^-?[\d.,]+$/.test(c.trim())));
    if (val === undefined) continue;
    out.push({ label, value: parseNum(val) });
  }
  return out.slice(0, 80);
}

// ---------- 3) TikTok Semua pesanan ----------
function parseTiktokOrders(sh: Sheet): ParsedFile {
  const hr = findHeaderRow(sh.rows, "order id", 3);
  if (hr < 0) throw new FormatError("Kolom “Order ID” tidak ditemukan di sheet OrderSKUList");
  const h = headerMap(sh.rows[hr]);
  const c = (...n: string[]) => need(h, ...n);
  const I = {
    no: c("order id"), status: c("order status"), sub: c("order substatus"), ret: c("cancelation/return type", "cancellation/return type"), seller: c("seller sku"), name: c("product name"),
    variation: c("variation"), qty: c("quantity"), retQty: c("sku quantity of return"), unit: c("sku unit original price"), after: c("sku subtotal after discount"), before: c("sku subtotal before discount"),
    sellerDisc: c("sku seller discount"), refund: c("order refund amount"), amount: c("order amount"), created: c("created time"), paid: c("paid time"), delivered: c("delivered time"),
    cancelReason: c("cancel reason"), track: c("tracking id"), deliv: c("delivery option"), provider: c("shipping provider name"), prov: c("province"), city: c("regency and city"),
    pay: c("payment method"), handle: c("creator handle"),
  };
  if (I.no < 0 || I.seller < 0) throw new FormatError("Header sheet OrderSKUList tidak sesuai format TikTok “Semua pesanan”");
  const byNo = new Map<string, ParsedOrder>();
  let rows = 0;
  // baris setelah header = deskripsi kolom → lewati bila Order ID bukan angka panjang
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[I.no]);
    if (!no || !/^\d{6,}$/.test(no)) continue;
    rows++;
    let o = byNo.get(no);
    if (!o) {
      o = {
        orderNo: no, orderedAt: parseDate(r[I.created]), paidAt: parseDate(r[I.paid]), completedAt: parseDate(r[I.delivered]),
        rawStatus: clean(str(r[I.status]), 120), rawSubstatus: clean(str(r[I.sub]), 120), rawReturn: clean(str(r[I.ret]), 60), cancelReason: clean(str(r[I.cancelReason]), 200),
        trackingNo: clean(str(r[I.track]), 60)?.toUpperCase() ?? null, shipOption: clean(str(r[I.deliv]), 60), courier: clean(str(r[I.provider]), 40), paymentMethod: clean(str(r[I.pay]), 60),
        city: clean(str(r[I.city]), 60), province: clean(str(r[I.prov]), 60), creatorHandle: clean(str(r[I.handle]), 60), affiliate: !!clean(str(r[I.handle]), 60),
        subtotal: 0, discount: 0, shippingPaid: 0, total: parseNum(r[I.amount]), refundAmount: parseNum(r[I.refund]), returnQty: 0, lines: [],
      };
      byNo.set(no, o);
    }
    if (!o.total) o.total = parseNum(r[I.amount]);
    const qty = Math.round(parseNum(r[I.qty]));
    const unit = parseNum(r[I.unit]);
    const amount = parseNum(r[I.after]) || Math.round(qty * unit);
    const retQty = Math.round(parseNum(r[I.retQty]));
    (o.extra ??= []).push(rawRow(sh.rows[hr], r));
    o.lines.push({ sku: str(r[I.seller]), variation: clean(str(r[I.variation]), 80), name: clean(str(r[I.name]), 120), qty, unitPrice: unit, amount: Math.round(amount), returnQty: retQty });
    o.subtotal += Math.round(parseNum(r[I.before]) || qty * unit);
    o.discount += Math.round(parseNum(r[I.sellerDisc]));
    o.returnQty += retQty;
  }
  const orders = [...byNo.values()];
  for (const o of orders) if (!o.total) o.total = Math.max(0, o.subtotal - o.discount) || o.lines.reduce((a, l) => a + l.amount, 0);
  const { from, to } = minMax(orders.map((o) => o.orderedAt));
  return { platform: "TIKTOK", kind: "ORDER", orders, incomes: [], withdrawals: [], periodFrom: from, periodTo: to, info: { rows, personalCols: personalCols(sh.rows[hr]) } };
}

// ---------- 4) TikTok income ----------
function parseTiktokIncome(sheets: Sheet[], sh: Sheet): ParsedFile {
  const hr = findHeaderRow(sh.rows, "id pesanan/penyesuaian", 3);
  if (hr < 0) throw new FormatError("Kolom “ID Pesanan/Penyesuaian” tidak ditemukan di sheet Detail pesanan");
  const header = sh.rows[hr];
  const h = headerMap(header);
  const I = {
    no: need(h, "id pesanan/penyesuaian"), type: need(h, "jenis transaksi"), ordered: need(h, "waktu pemesanan"), paid: need(h, "waktu pembayaran pesanan"),
    rel: need(h, "jumlah penyelesaian pembayaran"), adj: need(h, "jumlah penyesuaian"), income: need(h, "total pendapatan"), cost: need(h, "total biaya"),
  };
  if (I.no < 0 || I.rel < 0) throw new FormatError("Header sheet Detail pesanan tidak sesuai format TikTok income");
  const feeCols = header.map((c, i) => ({ k: String(c ?? "").trim(), i })).filter((x) => x.k && x.i !== I.cost && x.i !== I.rel && x.i !== I.income && looksLikeFee(x.k, "TIKTOK"));
  const incomes: ParsedIncome[] = [];
  let rows = 0;
  for (const r of sh.rows.slice(hr + 1)) {
    const no = str(r?.[I.no]);
    if (!no) continue;
    rows++;
    const t = norm(r[I.type]);
    const kind: ParsedIncome["kind"] = t === "pesanan" ? "ORDER" : /iklan|gmv/.test(t) ? "ADS" : "ADJUST";
    // Baris iklan/penyesuaian: nilainya di "Jumlah penyesuaian" bila kolom penyelesaian kosong
    const settle = Math.round(parseNum(r[I.rel])) || (kind === "ORDER" || I.adj < 0 ? 0 : Math.round(parseNum(r[I.adj])));
    const feeDetail: Record<string, number> = {};
    for (const { k, i } of feeCols) {
      const v = Math.round(parseNum(r[i]));
      if (v && !(k in feeDetail)) feeDetail[k] = v;
    }
    const totalCost = Math.abs(parseNum(r[I.cost]));
    const fees = totalCost || Object.values(feeDetail).reduce((a, b) => a + Math.abs(b), 0);
    incomes.push({
      kind, refNo: no, orderedAt: parseDate(r[I.ordered]), releasedAt: parseDate(r[I.paid]) ?? (kind === "ORDER" ? null : parseDate(r[I.ordered])), released: settle, productAmt: Math.round(parseNum(r[I.income])), refundAmt: 0, fees: Math.round(fees), feeDetail,
    });
  }
  const withdrawals: ParsedWithdrawal[] = [];
  const wd = sheetOf(sheets, "riwayat penarikan");
  if (wd) {
    const wr = findHeaderRow(wd.rows, "jenis transaksi", 4);
    if (wr >= 0) {
      const w = headerMap(wd.rows[wr]);
      const W = { type: need(w, "jenis transaksi"), ref: need(w, "id referensi"), req: need(w, "waktu permintaan"), total: need(w, "total"), status: need(w, "status"), done: need(w, "waktu keberhasilan") };
      for (const r of wd.rows.slice(wr + 1)) {
        const ref = str(r?.[W.ref]);
        if (!ref) continue;
        withdrawals.push({ txType: str(r[W.type]) ?? "-", refId: ref, requestedAt: parseDate(r[W.req]), doneAt: parseDate(r[W.done]), amount: Math.round(parseNum(r[W.total])), status: clean(str(r[W.status]), 40) });
        // kolom rekening bank sengaja tidak dibaca
      }
    }
  }
  const dates = (rows: ParsedIncome[]) => minMax(rows.flatMap((x) => [x.releasedAt, x.orderedAt]));
  const byOrder = dates(incomes.filter((x) => x.kind === "ORDER"));
  const any = byOrder.from ? byOrder : dates(incomes);
  const { from, to } = any.from ? any : minMax(withdrawals.flatMap((w) => [w.requestedAt, w.doneAt]));
  const rep = sheetOf(sheets, "laporan");
  let summaryTotal: number | undefined, summaryLabel: string | undefined, seller: string | undefined;
  try {
    const t = labelValue(rep, /jumlah penyelesaian|total penyelesaian|settlement amount|total settlement/);
    if (t) ({ value: summaryTotal, label: summaryLabel } = t);
    seller = textRight(rep, /^(nama toko|shop name|username|nama pengguna)/);
  } catch {
    /* info saja */
  }
  const read = [sh.name, ...(rep ? [rep.name] : []), ...(wd ? [wd.name] : [])];
  const skipped = sheets.filter((x) => !read.includes(x.name)).map((x) => ({ name: x.name, reason: /penjelasan/.test(norm(x.name)) ? "dilewati: penjelasan (dokumentasi biaya)" : "tidak dipakai" }));
  return { platform: "TIKTOK", kind: "INCOME", orders: [], incomes, withdrawals, periodFrom: from, periodTo: to, info: { rows, seller, summaryTotal, summaryLabel, summaryRows: summaryList(rep), sheets: { read, skipped } } };
}

// ---------- 5) Shopee "Transaksi Saldo Penjual" (format toleran: dideteksi dari header kolom) ----------
const BAL_DATE = ["tanggal", "tanggal transaksi", "waktu", "waktu transaksi", "date", "transaction date", "tanggal & waktu", "tanggal dan waktu"];
const BAL_AMOUNT = ["jumlah", "amount", "nominal", "jumlah transaksi", "mutasi", "total"];
const BAL_IN = ["uang masuk", "pemasukan", "kredit", "masuk", "credit"];
const BAL_OUT = ["uang keluar", "pengeluaran", "debit", "keluar"];
const BAL_TYPE = ["jenis transaksi", "tipe transaksi", "jenis", "tipe", "deskripsi", "keterangan", "description", "transaction type", "type", "catatan"];

function findBalanceHeader(sheet: Sheet) {
  for (let r = 0; r < Math.min(sheet.rows.length, 40); r++) {
    const row = (sheet.rows[r] ?? []).map(norm);
    const idx = (names: string[]) => names.map((n) => row.indexOf(n)).find((i) => i >= 0) ?? -1;
    const date = idx(BAL_DATE), amount = idx(BAL_AMOUNT), inn = idx(BAL_IN), out = idx(BAL_OUT);
    const types = row.map((c, i) => (BAL_TYPE.includes(c) ? i : -1)).filter((i) => i >= 0);
    if (date >= 0 && types.length && (amount >= 0 || (inn >= 0 && out >= 0))) return { r, date, amount, inn, out, types, order: idx(["no. pesanan", "order id", "id pesanan"]) };
  }
  return null;
}

const ADS_RE = /iklan|shopee ads|\bads\b/;
const WD_RE = /penarikan|withdraw|tarik dana/;

function parseShopeeBalance(sheet: Sheet, h: NonNullable<ReturnType<typeof findBalanceHeader>>): ParsedFile {
  const incomes: ParsedIncome[] = [];
  const withdrawals: ParsedWithdrawal[] = [];
  const seen = new Map<string, number>();
  let others = 0, othersTotal = 0, rows = 0;
  for (const r of sheet.rows.slice(h.r + 1)) {
    const date = parseDate(r?.[h.date]);
    if (!date) continue;
    const amount = h.amount >= 0 ? parseNum(r[h.amount]) : parseNum(r[h.inn]) - Math.abs(parseNum(r[h.out]));
    if (!amount) continue;
    rows++;
    const text = h.types.map((i) => str(r[i]) ?? "").join(" | ");
    const low = text.toLowerCase();
    // kunci stabil agar unggah ulang periode tumpang tindih tidak dobel (baris identik dibedakan nomor urutnya)
    const base = `${date.toISOString()}|${Math.round(amount)}|${low.slice(0, 80)}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const ref = `SB${createHash("sha1").update(`${base}|${nth}`).digest("hex").slice(0, 14)}`;
    if (WD_RE.test(low)) withdrawals.push({ txType: "Withdrawal", refId: ref, requestedAt: date, doneAt: date, amount: Math.abs(Math.round(amount)), status: "Berhasil" });
    else if (ADS_RE.test(low)) incomes.push({ kind: "TOPUP", refNo: ref, orderedAt: date, releasedAt: date, released: -Math.abs(Math.round(amount)), productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {} });
    else {
      others++;
      othersTotal += Math.round(amount);
    }
  }
  const { from, to } = minMax([...incomes.map((x) => x.releasedAt), ...withdrawals.map((w) => w.requestedAt)]);
  const note = `Saldo Penjual: ${incomes.length} isi saldo iklan, ${withdrawals.length} penarikan dana, ${others} transaksi lain (info saja${others ? `, total Rp ${othersTotal.toLocaleString("id-ID")}` : ""})`;
  return { platform: "SHOPEE", kind: "INCOME", orders: [], incomes, withdrawals, periodFrom: from, periodTo: to, info: { rows, note } };
}

// ---------- 6) Shopee "my_balance_transaction_report" (Buku Saldo Penjual; format asli) ----------
const normDesc = (d: string) => d.replace(/\b[0-9A-Z]{9,}\b/g, "").replace(/\s+/g, " ").trim();

function findBalanceReportHeader(sh: Sheet) {
  for (let r = 0; r < Math.min(sh.rows.length, 40); r++) {
    const h = headerMap(sh.rows[r] ?? []);
    if (h.has("tanggal transaksi") && h.has("tipe transaksi") && h.has("saldo akhir") && h.has("jumlah")) return { r, h };
  }
  return null;
}

function classifyBalance(type: string, desc: string): string {
  const t = `${type} ${desc}`.toLowerCase();
  if (/penghasilan dari pesanan/.test(t)) return "PENGHASILAN";
  if (/penarikan dana|withdraw/.test(t)) return "PENARIKAN";
  if (/pembayaran dengan saldo penjual|isi ulang saldo iklan|koin penjual/.test(t)) return "TOPUP_IKLAN";
  if (/sample|sampel/.test(t)) return "AFFILIATE_SAMPEL";
  if (/penyesuaian|adjustment|kompensasi|pengembalian dana komisi/.test(t)) return "PENYESUAIAN";
  return "LAINNYA";
}

function parseShopeeBalanceReport(sh: Sheet, hdr: NonNullable<ReturnType<typeof findBalanceReportHeader>>): ParsedFile {
  const { r: hr, h } = hdr;
  const C = { date: h.get("tanggal transaksi")!, type: h.get("tipe transaksi")!, desc: need(h, "deskripsi"), order: need(h, "no. pesanan"), dir: need(h, "jenis transaksi"), amt: h.get("jumlah")!, status: need(h, "status"), bal: h.get("saldo akhir")! };
  const meta = { seller: textRight(sh, /username/), from: textRight(sh, /^dari$/), to: textRight(sh, /^ke$/), masuk: labelValue(sh, /^total saldo masuk$/)?.value, keluar: labelValue(sh, /^total saldo keluar$/)?.value };
  const txs: ParsedBalanceTx[] = [];
  const incomes: ParsedIncome[] = [];
  const withdrawals: ParsedWithdrawal[] = [];
  const seen = new Map<string, number>();
  let pos = 0;
  for (const r of sh.rows.slice(hr + 1)) {
    const date = parseDate(r?.[C.date]);
    if (!date) continue;
    let amount = Math.round(parseNum(r[C.amt]));
    if (!amount) continue;
    if (C.dir >= 0 && /keluar/i.test(String(r[C.dir] ?? "")) && amount > 0) amount = -amount;
    const type = clean(str(r[C.type]), 80) ?? "-";
    const desc = clean(str(r[C.desc]), 200);
    const orderNo = clean(str(r[C.order]), 40);
    const bal = r[C.bal] === null || r[C.bal] === undefined || r[C.bal] === "" ? null : Math.round(parseNum(r[C.bal]));
    const category = classifyBalance(type, desc ?? "");
    const base = createHash("sha1").update(`${date.toISOString()}|${type}|${desc ?? ""}|${orderNo ?? ""}|${amount}|${bal ?? ""}`).digest("hex").slice(0, 16);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const txKey = nth > 1 ? `${base}#${nth}` : base;
    txs.push({ txKey, date, type, description: desc, orderNo, amount, status: clean(str(r[C.status]), 30), balanceAfter: bal, pos: pos++, category });
    // Penghasilan dari pesanan: hanya buku saldo (angka per pesanan datang dari file Penghasilan; dipakai untuk pencocokan)
    if (category === "PENARIKAN") withdrawals.push({ txType: "Withdrawal", refId: txKey, requestedAt: date, doneAt: date, amount: Math.abs(amount), status: clean(str(r[C.status]), 30) ?? "Berhasil" });
    else if (category === "TOPUP_IKLAN") incomes.push({ kind: "TOPUP", refNo: txKey, orderedAt: date, releasedAt: date, released: amount, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {} });
    else if (category === "PENYESUAIAN" || category === "AFFILIATE_SAMPEL") incomes.push({ kind: "ADJUST", refNo: orderNo ?? txKey, orderedAt: date, releasedAt: date, released: amount, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: { [normDesc(desc ?? type) || type]: amount } });
  }
  const by = (c: string) => txs.filter((t) => t.category === c);
  const sum = (a: ParsedBalanceTx[]) => a.reduce((x, t) => x + t.amount, 0);
  const { from, to } = minMax(txs.map((t) => t.date));
  const f = (v: number) => v.toLocaleString("id-ID");
  const inSum = txs.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const outSum = txs.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
  const check = meta.masuk !== undefined && meta.keluar !== undefined && (Math.abs(inSum - meta.masuk) > 1 || Math.abs(outSum - meta.keluar) > 1) ? ` ⚠ Total di file (masuk ${f(meta.masuk)} / keluar ${f(meta.keluar)}) berbeda dengan jumlah baris (masuk ${f(inSum)} / keluar ${f(outSum)}).` : "";
  const note = `Buku Saldo Penjual: ${txs.length} mutasi · penghasilan ${f(sum(by("PENGHASILAN")))} · ${by("PENARIKAN").length} penarikan ${f(sum(by("PENARIKAN")))} · isi saldo iklan ${f(sum(by("TOPUP_IKLAN")))} (${by("TOPUP_IKLAN").length}) · penyesuaian ${f(sum(by("PENYESUAIAN")) + sum(by("AFFILIATE_SAMPEL")))} (${by("PENYESUAIAN").length + by("AFFILIATE_SAMPEL").length})${check}`;
  return { platform: "SHOPEE", kind: "BALANCE", orders: [], incomes, withdrawals, balanceTx: txs, periodFrom: from, periodTo: to, info: { seller: meta.seller, rows: txs.length, note, summaryTotal: meta.masuk !== undefined && meta.keluar !== undefined ? meta.masuk + meta.keluar : undefined, summaryLabel: "Total Saldo Masuk + Keluar" } };
}

// ---------- 7) Shopee "<username>_adwords_bill_*.csv" (mutasi saldo iklan) ----------
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseAdsBillCsv(text: string): ParsedFile | null {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  const hr = rows.findIndex((r) => /^urutan$/i.test((r[0] ?? "").trim()) && r.some((c) => /^waktu/i.test(c.trim())) && r.some((c) => /^jumlah/i.test(c.trim())));
  if (hr < 0 || !rows.slice(0, hr).some((r) => /riwayat transaksi|username/i.test(r[0] ?? ""))) return null;
  const head = rows[hr].map((c) => c.trim().toLowerCase());
  const C = { time: head.findIndex((c) => c.startsWith("waktu")), desc: head.indexOf("deskripsi"), amt: head.findIndex((c) => c.startsWith("jumlah")), note: head.indexOf("catatan") };
  const meta = (re: RegExp) => rows.slice(0, hr).find((r) => re.test((r[0] ?? "").trim().toLowerCase()))?.[1]?.trim();
  const seller = meta(/^username/);
  const incomes: ParsedIncome[] = [];
  let topup = 0, usage = 0;
  for (const r of rows.slice(hr + 1)) {
    const date = parseDate(r[C.time]);
    const amount = Math.round(parseNum(r[C.amt]));
    if (!date || !amount) continue;
    const desc = clean((r[C.desc] ?? "").trim() || null, 120) ?? "-";
    const day = new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
    incomes.push({ kind: "ADSUSE", refNo: `AD${day}${createHash("sha1").update(desc).digest("hex").slice(0, 8)}`, orderedAt: date, releasedAt: date, released: amount, productAmt: 0, refundAmt: 0, fees: 0, feeDetail: { [desc]: amount } });
    if (/isi saldo|top.?up/i.test(desc)) topup += amount; else usage += amount;
  }
  const { from, to } = minMax(incomes.map((i) => i.releasedAt));
  const f = (v: number) => v.toLocaleString("id-ID");
  return { platform: "SHOPEE", kind: "ADSBILL", orders: [], incomes, withdrawals: [], periodFrom: from, periodTo: to, info: { seller, rows: incomes.length, note: `Saldo iklan Shopee: ${incomes.length} mutasi · isi saldo ${f(topup)} · pemakaian/koreksi iklan ${f(usage)} (biaya iklan aktual per jenis)` } };
}

/** Header yang terbaca (untuk pesan galat bila format tak dikenali) */
function describeSheets(sheets: Sheet[]) {
  return sheets.slice(0, 4).map((s) => {
    const row = (s.rows.find((r) => (r ?? []).filter((c) => c !== null && String(c).trim() !== "").length >= 3) ?? []).filter((c) => c !== null && String(c).trim() !== "").slice(0, 10).map((c) => String(c).trim().slice(0, 30));
    return `sheet “${s.name}”: ${row.join(" | ") || "(kosong)"}`;
  }).join("; ");
}

/** Kenali & baca satu file; format tak dikenal → FormatError berpesan jelas */
export async function parseMarketplaceFile(buf: Buffer | Uint8Array): Promise<ParsedFile> {
  const r = await parseInner(buf);
  if (!r.info.sheets) {
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) r.info.sheets = { read: ["CSV"], skipped: [] };
    else {
      const sheets = await readXlsx(buf);
      const main = r.kind === "ORDER" ? (sheetOf(sheets, "orders") ?? sheetOf(sheets, "orderskulist")) : undefined;
      const read = main ? [main.name] : sheets.filter((x) => x.rows.length).map((x) => x.name);
      r.info.sheets = { read, skipped: sheets.filter((x) => !read.includes(x.name)).map((x) => ({ name: x.name, reason: /penjelasan|instruction|petunjuk/.test(norm(x.name)) ? "dilewati: penjelasan/dokumentasi" : "tidak dipakai" })) };
    }
  }
  return r;
}

async function parseInner(buf: Buffer | Uint8Array): Promise<ParsedFile> {
  // CSV (saldo iklan Shopee) bukan zip/xlsx
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    const ads = parseAdsBillCsv(Buffer.from(buf).toString("utf8"));
    if (ads) return ads;
    throw new FormatError("Format file tidak dikenali. Unggah file Excel (.xlsx) asli dari Shopee/TikTok Shop, atau CSV saldo iklan Shopee (adwords_bill).");
  }
  let sheets: Sheet[];
  try {
    sheets = await readXlsx(buf);
  } catch (e) {
    if (e instanceof XlsxError) throw new FormatError(e.message);
    throw e;
  }
  const orders = sheetOf(sheets, "orders");
  if (orders && orders.rows.slice(0, 3).some((r) => (r ?? []).some((c) => norm(c) === "sku induk"))) return parseShopeeOrders(orders);
  const peng = sheetOf(sheets, "penghasilan");
  if (peng) return parseShopeeIncome(sheets, peng);
  const osl = sheetOf(sheets, "orderskulist");
  if (osl) return parseTiktokOrders(osl);
  const det = sheetOf(sheets, "detail pesanan");
  if (det) return parseTiktokIncome(sheets, det);
  for (const sh of sheets) {
    const bp = findBalanceReportHeader(sh);
    if (bp) return parseShopeeBalanceReport(sh, bp);
  }
  for (const sh of sheets) {
    const bh = findBalanceHeader(sh);
    if (bh) return parseShopeeBalance(sh, bh);
  }
  throw new FormatError(`Format file tidak dikenali. Gunakan file Excel asli dari Shopee (Order.all / Income sudah dilepas / Transaksi Saldo Penjual) atau TikTok Shop (Semua pesanan / income). Yang terbaca: ${describeSheets(sheets)}`);
}
