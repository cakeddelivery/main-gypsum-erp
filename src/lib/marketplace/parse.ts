import { createHash } from "node:crypto";
import { defaultCategory, looksLikeFee } from "./feeMap";
import { readXlsx, XlsxError, type Cell, type Sheet } from "./xlsx";

/**
 * Pembaca file Excel Shopee & TikTok Shop (murni, tanpa database). Deteksi dari NAMA SHEET + HEADER, bukan nama file.
 * DATA PRIBADI: nama/telepon/alamat/catatan pembeli, rekening bank TIDAK dibaca ke hasil.
 */
export type Platform = "SHOPEE" | "TIKTOK";
export type FileKind = "ORDER" | "INCOME";

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
};
export type ParsedIncome = {
  kind: "ORDER" | "ADS" | "ADJUST";
  refNo: string;
  orderedAt: Date | null;
  releasedAt: Date | null;
  released: number;
  productAmt: number;
  refundAmt: number;
  fees: number;
  feeDetail: Record<string, number>;
};
export type ParsedWithdrawal = { txType: string; refId: string; requestedAt: Date | null; doneAt: Date | null; amount: number; status: string | null };
export type ParsedFile = {
  platform: Platform;
  kind: FileKind;
  orders: ParsedOrder[];
  incomes: ParsedIncome[];
  withdrawals: ParsedWithdrawal[];
  periodFrom: Date | null;
  periodTo: Date | null;
  /** Info tampilan (mis. username penjual dari sheet Summary Shopee) */
  info: { seller?: string; rows: number; /** Keterangan tambahan untuk pratinjau (mis. ringkasan Saldo Penjual) */ note?: string };
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
    const qty = Math.round(parseNum(r[I.qty]));
    const unit = parseNum(r[I.priceAfter]) || parseNum(r[I.price]);
    const retQty = Math.round(parseNum(r[I.retQty]));
    // SKU: Nomor Referensi SKU; bila kosong pakai SKU Induk (varian dibedakan lewat Nama Variasi)
    const ref = str(r[I.ref]);
    o.lines.push({ sku: ref ?? str(r[I.skuInduk]), variation: ref ? null : clean(str(r[I.variation]), 80), name: clean(str(r[I.name]), 120), qty, unitPrice: unit, amount: Math.round(qty * unit), returnQty: retQty });
    o.returnQty += retQty;
  }
  const orders = [...byNo.values()];
  const { from, to } = minMax(orders.map((o) => o.orderedAt));
  return { platform: "SHOPEE", kind: "ORDER", orders, incomes: [], withdrawals: [], periodFrom: from, periodTo: to, info: { rows } };
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
  // Summary: username penjual (info saja)
  let seller: string | undefined;
  const sum = sheetOf(sheets, "summary");
  try {
    for (const row of sum?.rows ?? []) {
      const i = (row ?? []).findIndex((c) => /username|nama pengguna/i.test(String(c ?? "")));
      if (i >= 0) {
        seller = (row.slice(i + 1).map(str).find(Boolean) as string | undefined) ?? undefined;
        break;
      }
    }
  } catch {
    /* info saja */
  }
  const { from, to } = minMax(incomes.map((x) => x.releasedAt ?? x.orderedAt));
  return { platform: "SHOPEE", kind: "INCOME", orders: [], incomes, withdrawals: [], periodFrom: from, periodTo: to, info: { seller, rows } };
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
    const qty = Math.round(parseNum(r[I.qty]));
    const unit = parseNum(r[I.unit]);
    const amount = parseNum(r[I.after]) || Math.round(qty * unit);
    const retQty = Math.round(parseNum(r[I.retQty]));
    o.lines.push({ sku: str(r[I.seller]), variation: clean(str(r[I.variation]), 80), name: clean(str(r[I.name]), 120), qty, unitPrice: unit, amount: Math.round(amount), returnQty: retQty });
    o.subtotal += Math.round(parseNum(r[I.before]) || qty * unit);
    o.discount += Math.round(parseNum(r[I.sellerDisc]));
    o.returnQty += retQty;
  }
  const orders = [...byNo.values()];
  const { from, to } = minMax(orders.map((o) => o.orderedAt));
  return { platform: "TIKTOK", kind: "ORDER", orders, incomes: [], withdrawals: [], periodFrom: from, periodTo: to, info: { rows } };
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
  return { platform: "TIKTOK", kind: "INCOME", orders: [], incomes, withdrawals, periodFrom: from, periodTo: to, info: { rows } };
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
    else if (ADS_RE.test(low)) incomes.push({ kind: "ADS", refNo: ref, orderedAt: date, releasedAt: date, released: -Math.abs(Math.round(amount)), productAmt: 0, refundAmt: 0, fees: 0, feeDetail: {} });
    else {
      others++;
      othersTotal += Math.round(amount);
    }
  }
  const { from, to } = minMax([...incomes.map((x) => x.releasedAt), ...withdrawals.map((w) => w.requestedAt)]);
  const note = `Saldo Penjual: ${incomes.length} iklan, ${withdrawals.length} penarikan dana, ${others} transaksi lain (info saja${others ? `, total Rp ${othersTotal.toLocaleString("id-ID")}` : ""})`;
  return { platform: "SHOPEE", kind: "INCOME", orders: [], incomes, withdrawals, periodFrom: from, periodTo: to, info: { rows, note } };
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
    const bh = findBalanceHeader(sh);
    if (bh) return parseShopeeBalance(sh, bh);
  }
  throw new FormatError(`Format file tidak dikenali. Gunakan file Excel asli dari Shopee (Order.all / Income sudah dilepas / Transaksi Saldo Penjual) atau TikTok Shop (Semua pesanan / income). Yang terbaca: ${describeSheets(sheets)}`);
}
