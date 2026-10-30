import type { ItemType } from "@prisma/client";

/** Satuan beli / satuan stok (permintaan owner 30/10/2026) */
export const PURCHASE_UNITS = [
  { value: "sak", label: "Sak (Karung)" },
  { value: "kg", label: "Kg (Kilogram)" },
  { value: "botol", label: "Botol" },
  { value: "dus", label: "Dus/Box" },
  { value: "pack", label: "Pack/Bungkus" },
  { value: "pcs", label: "Pcs (Buah)" },
  { value: "liter", label: "Liter" },
  { value: "roll", label: "Roll" },
] as const;

/** Satuan dasar yang dipakai resep HPP */
export const BASE_UNITS = [
  { value: "kg", label: "Kg (Kilogram)" },
  { value: "gram", label: "Gram" },
  { value: "pcs", label: "Pcs (Buah)" },
  { value: "ml", label: "ml (Mililiter)" },
  { value: "liter", label: "Liter" },
] as const;

/** Kategori per jenis item; `prefix` = awalan kode otomatis (BU-001, BSJ-001, MG-001) */
export const ITEM_CATEGORIES: Record<ItemType, { name: string; prefix: string }[]> = {
  BAHAN_BAKU: [
    { name: "Bahan Utama", prefix: "BU" },
    { name: "Cat & Pewarna", prefix: "CT" },
    { name: "Bahan Pendukung", prefix: "BP" },
    { name: "Kemasan & Packaging", prefix: "KM" },
    { name: "Perlengkapan Produksi", prefix: "PP" },
  ],
  BARANG_DALAM_PROSES: [{ name: "Barang Setengah Jadi", prefix: "BSJ" }],
  BARANG_JADI: [{ name: "Mainan Gypsum", prefix: "MG" }],
};

const TYPE_PREFIX: Record<ItemType, string> = { BAHAN_BAKU: "BB", BARANG_DALAM_PROSES: "BSJ", BARANG_JADI: "MG" };

export function categoryPrefix(type: ItemType, category?: string | null) {
  return ITEM_CATEGORIES[type].find((c) => c.name === category)?.prefix ?? TYPE_PREFIX[type];
}

/**
 * Opsi satuan untuk dropdown. Satuan lama yang ditulis bebas (mis. "lembar") tetap muncul
 * sebagai opsi tambahan supaya data item lama tidak berubah saat diubah.
 */
export function unitOptions(list: readonly { value: string; label: string }[], current?: string | null) {
  const cur = current?.trim();
  if (!cur || list.some((u) => u.value === cur.toLowerCase())) return [...list];
  return [...list, { value: cur, label: `${cur} (lama)` }];
}

/** Cocokkan satuan lama ke opsi baku tanpa beda huruf besar/kecil ("Sak" → "sak") */
export function normalizeUnit(list: readonly { value: string }[], unit?: string | null) {
  const u = unit?.trim();
  if (!u) return "";
  return list.find((x) => x.value === u.toLowerCase())?.value ?? u;
}
