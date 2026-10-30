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

/** Satuan yang bisa saling dikonversi untuk satuan pakai resep (nilai = kelipatan satuan terkecil) */
const UNIT_FAMILY: Record<string, [string, number]> = { kg: ["massa", 1000], gram: ["massa", 1], liter: ["volume", 1000], ml: ["volume", 1], pcs: ["jumlah", 1] };

/** Pilihan satuan pakai untuk komponen dengan satuan resep `recipeUnit` */
export function useUnitOptions(recipeUnit: string) {
  const f = UNIT_FAMILY[recipeUnit.trim().toLowerCase()];
  return f ? Object.keys(UNIT_FAMILY).filter((u) => UNIT_FAMILY[u][0] === f[0]) : [recipeUnit];
}

/** Qty dalam satuan pakai → qty dalam satuan resep komponen (500 gram → 0,5 bila resep dalam kg) */
export function toRecipeQty(qty: number, useUnit: string | null | undefined, recipeUnit: string) {
  const a = useUnit ? UNIT_FAMILY[useUnit.trim().toLowerCase()] : undefined;
  const b = UNIT_FAMILY[recipeUnit.trim().toLowerCase()];
  if (!a || !b || a[0] !== b[0]) return qty;
  return (qty * a[1]) / b[1];
}

export function fromRecipeQty(qty: number, useUnit: string | null | undefined, recipeUnit: string) {
  return qty / toRecipeQty(1, useUnit, recipeUnit);
}
