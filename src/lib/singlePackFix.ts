import type { Prisma, ProductVariant } from "@prisma/client";

/**
 * Laporan shift memakai barang jadi "satuan" per series = barang jadi produk SATUAN (produk katalog lebih dulu).
 * Penautan lama (#151, ke BJ-SAT-<series>) DIHAPUS karena salah arah: barang yang benar = "Single Pack <series>"
 * (divisi Packing). Penyatuan: src/lib/singlePackMerge.ts (npm run single-pack:satukan).
 */
/** Urutan pemilihan produk satuan oleh laporan shift: produk katalog (induk) lebih dulu, lalu urut kode */
export const SATUAN_ORDER = [{ familyId: { sort: "asc", nulls: "last" } }, { sku: "asc" }] as const satisfies Prisma.ProductOrderByWithRelationInput[];

export const SINGLE_PACK_VARIANTS: ProductVariant[] = ["HEWAN", "COWOK", "CEWEK", "TRANSPORTASI"];
