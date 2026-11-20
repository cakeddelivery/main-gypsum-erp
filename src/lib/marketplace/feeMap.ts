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
  REFUND: { label: "Refund ke pembeli", counted: true },
  PENYESUAIAN: { label: "Penyesuaian", counted: true },
  PAJAK: { label: "Pajak (PPh)", counted: true },
  LAINNYA: { label: "Lainnya", counted: true },
  ABAIKAN: { label: "Abaikan (bukan potongan)", counted: false },
} as const;
export type FeeCategory = keyof typeof FEE_CATEGORIES;
export const UNMAPPED = "BELUM" as const;
export type FeeCategoryOrNone = FeeCategory | typeof UNMAPPED;

export const normCol = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Aturan bawaan (urut: yang spesifik dulu) */
const RULES: [RegExp, FeeCategory][] = [
  [/gratis ongkir xtra|layanan logistik/, "ONGKIR_PROGRAM"],
  [/komisi ams|afiliasi|affiliate|komisi kreator/, "AFFILIATE"],
  [/komisi platform|komisi dinamis|biaya administrasi|biaya transaksi|pre-?order/, "ADMIN"],
  [/proses pesanan|pemrosesan pesanan/, "PROSES"],
  [/premi/, "ASURANSI"],
  [/shopee live|layanan video|live xtra/, "LAYANAN"],
  [/iklan|isi saldo/, "IKLAN"],
  [/voucher|diskon penjual/, "VOUCHER"],
  [/pengembalian dana|refund/, "REFUND"],
  [/pph|pajak/, "PAJAK"],
  [/ongkos kirim|ongkir|jasa kirim|biaya pengiriman/, "ONGKIR"],
  [/penyesuaian/, "PENYESUAIAN"],
];
export const defaultCategory = (column: string): FeeCategoryOrNone => RULES.find(([r]) => r.test(normCol(column)))?.[1] ?? UNMAPPED;

/** Kolom yang tampak seperti komponen biaya (ikut disimpan walau kategorinya belum dikenal) */
export const looksLikeFee = (column: string) => defaultCategory(column) !== UNMAPPED || /biaya|komisi|premi|pph|pajak|ongkir|ongkos|voucher|diskon|pengembalian|iklan|saldo|layanan|fee|potongan|penyesuaian/i.test(column);

/** Kategori akhir: pemetaan buatan pengguna (`overrides`: kunci "PLATFORM|kolom") menimpa bawaan */
export function categoryOf(platform: Platform, column: string, overrides?: Map<string, string>): FeeCategoryOrNone {
  const o = overrides?.get(`${platform}|${normCol(column)}`);
  if (o && (o in FEE_CATEGORIES)) return o as FeeCategory;
  return defaultCategory(column);
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
        unmapped[col] = (unmapped[col] ?? 0) + v;
        counted += v;
        continue;
      }
      byCategory[c] = (byCategory[c] ?? 0) + v;
      if (FEE_CATEGORIES[c].counted) counted += v;
    }
  }
  return { byCategory, byColumn, unmapped, counted };
}
