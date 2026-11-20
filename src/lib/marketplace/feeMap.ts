import type { Platform } from "./parse";

/**
 * Kategori potongan marketplace. Nama kolom biaya di file platform dipetakan ke kategori; yang belum dikenal
 * jadi "Belum dipetakan" (tidak pernah dibuang) dan bisa dipetakan sendiri di halaman Pemetaan biaya.
 */
export const FEE_CATEGORIES = {
  ADMIN: { label: "Admin / komisi platform", counted: true },
  PROSES: { label: "Biaya proses pesanan", counted: true },
  ONGKIR_PROGRAM: { label: "Program ongkir (Xtra / layanan logistik)", counted: true },
  ONGKIR: { label: "Ongkir (selisih)", counted: true },
  AFFILIATE: { label: "Affiliate / komisi kreator", counted: true },
  IKLAN: { label: "Iklan", counted: true },
  ASURANSI: { label: "Asuransi (premi)", counted: true },
  LAYANAN: { label: "Layanan Live / video", counted: true },
  VOUCHER: { label: "Voucher / diskon penjual (info)", counted: false },
  RINCIAN: { label: "Rincian komponen (sudah termasuk di potongan lain)", counted: false },
  INFO: { label: "Harga & diskon (info, bukan potongan saldo)", counted: false },
  REFUND: { label: "Refund ke pembeli", counted: true },
  PENYESUAIAN: { label: "Penyesuaian", counted: true },
  PAJAK: { label: "Pajak (PPh)", counted: true },
  LAINNYA: { label: "Lainnya", counted: true },
  ABAIKAN: { label: "Abaikan (bukan potongan)", counted: false },
} as const;
export type FeeCategory = keyof typeof FEE_CATEGORIES;
export const UNMAPPED = "BELUM" as const;
/** Voucher penjual mengurangi saldo di Shopee, tetapi di TikTok hanya info (sudah ada di harga) */
export const isCounted = (c: FeeCategory, platform: Platform) => (c === "VOUCHER" ? platform === "SHOPEE" : FEE_CATEGORIES[c].counted);
export type FeeCategoryOrNone = FeeCategory | typeof UNMAPPED;

export const normCol = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Kolom yang bukan uang sama sekali (ID, waktu, berat, mata uang, dst.) — tidak pernah disimpan sebagai biaya */
const IGNORE = /(^|\s)id(\s|$)|waktu|tanggal|berat|mata uang|currency|jenis |metode|status|nama |no\. |nomor|alasan|jumlah item|kuantitas|sku/i;

type Rule = [RegExp, FeeCategory];
/** Aturan umum + khusus platform (yang spesifik dulu). Kolom tak dikenal = "BELUM" dan TIDAK ikut total sampai dipetakan. */
const SHOPEE: Rule[] = [
  [/pre-?order/, "ADMIN"],
  // info grup pembeli di kolom belakang (jangan dijumlah dengan rincian penghasilan)
  [/^pengembalian dana ke pembeli$|jumlah dibayar pembeli|pro-?rata/, "INFO"],
  [/pengembalian biaya kirim/, "ONGKIR"],
  [/gratis ongkir xtra/, "ONGKIR_PROGRAM"],
  [/ongkos kirim|ongkir|jasa kirim/, "ONGKIR"],
];
const TIKTOK: Rule[] = [
  [/^biaya komisi platform$|^komisi dinamis$/, "ADMIN"],
  [/^biaya pemrosesan pesanan$/, "PROSES"],
  [/^ongkir$/, "ONGKIR"],
  [/^komisi afiliasi$|^komisi iklan toko afiliasi$/, "AFFILIATE"],
  [/^biaya layanan pre-?order$/, "LAYANAN"],
  // sub-rincian: sudah termasuk di komponen di atas, JANGAN dijumlah lagi
  [/biaya layanan logistik|biaya komisi sebelum diskon|diskon \(dari belanja iklan\)|ongkir yang (ditalangi|ditanggung)|diskon ongkir/, "RINCIAN"],
  // bagian "dari harga coret ke pendapatan" (info)
  [/subtotal|diskon penjual|diskon platform|pengembalian dana/, "INFO"],
];
const COMMON: Rule[] = [
  [/komisi ams|afiliasi|affiliate|komisi kreator/, "AFFILIATE"],
  [/komisi platform|komisi dinamis|biaya administrasi|biaya transaksi/, "ADMIN"],
  [/pre-?order|shopee live|layanan video|live xtra/, "LAYANAN"],
  [/proses pesanan|pemrosesan pesanan/, "PROSES"],
  [/premi/, "ASURANSI"],
  [/iklan|isi saldo/, "IKLAN"],
  [/voucher/, "VOUCHER"],
  [/jumlah pengembalian dana|refund/, "REFUND"],
  [/pph|pajak/, "PAJAK"],
  [/penyesuaian/, "PENYESUAIAN"],
];
export const ignoredColumn = (column: string) => IGNORE.test(column.trim());
export function defaultCategory(column: string, platform?: Platform): FeeCategoryOrNone {
  const c = normCol(column);
  if (ignoredColumn(c)) return "ABAIKAN";
  const rules = platform === "SHOPEE" ? [...SHOPEE, ...COMMON] : platform === "TIKTOK" ? [...TIKTOK, ...COMMON] : [...SHOPEE, ...TIKTOK, ...COMMON];
  return rules.find(([r]) => r.test(c))?.[1] ?? UNMAPPED;
}

/** Kolom yang disimpan: bukan kolom non-uang, dan dikenal atau tampak seperti komponen biaya */
export const looksLikeFee = (column: string, platform?: Platform) => {
  if (ignoredColumn(column)) return false;
  return defaultCategory(column, platform) !== UNMAPPED || /biaya|komisi|premi|pph|pajak|ongkir|ongkos|voucher|diskon|pengembalian|iklan|saldo|layanan|fee|potongan|penyesuaian/i.test(column);
};

/** Kategori akhir: pemetaan buatan pengguna (`overrides`: kunci "PLATFORM|kolom") menimpa bawaan */
export function categoryOf(platform: Platform, column: string, overrides?: Map<string, string>): FeeCategoryOrNone {
  const o = overrides?.get(`${platform}|${normCol(column)}`);
  if (o && (o in FEE_CATEGORIES)) return o as FeeCategory;
  return defaultCategory(column, platform);
}

export type FeeTotals = { byCategory: Record<string, number>; byColumn: Record<string, number>; unmapped: Record<string, number>; counted: number };
/** Jumlahkan rincian biaya (nilai bertanda dari file) per kategori */
export function sumFees(platform: Platform, details: Record<string, number>[], overrides?: Map<string, string>): FeeTotals {
  const byCategory: Record<string, number> = {};
  const byColumn: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  let counted = 0;
  for (const d of details) {
    for (const [col, v] of Object.entries(d)) {
      byColumn[normCol(col)] = (byColumn[normCol(col)] ?? 0) + v;
      const c = categoryOf(platform, col, overrides);
      if (c === UNMAPPED) {
        unmapped[col] = (unmapped[col] ?? 0) + v; // tampil, tetapi belum masuk total sampai dipetakan
        continue;
      }
      byCategory[c] = (byCategory[c] ?? 0) + v;
      if (isCounted(c, platform)) counted += v;
    }
  }
  return { byCategory, byColumn, unmapped, counted };
}
