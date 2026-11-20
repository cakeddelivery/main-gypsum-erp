import type { Prisma, ProductVariant } from "@prisma/client";
import { prisma } from "./db";
import { SATUAN_FAMILY } from "./productFamily";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Laporan shift memakai barang jadi "satuan" per series = produk SATUAN pertama (urut kode) yang punya barang jadi.
 * Bila produk katalog (induk "Satuan Single Pack") menunjuk barang lain, barang di laporan tidak ditemukan
 * di katalog → muncul di "Produk jadi lainnya". Fungsi ini merencanakan penautan ulang `finishedItemId`
 * (dipindah bila barang itu dipegang produk lama) tanpa menghapus apa pun dan tanpa menyentuh stok.
 */
/** Urutan pemilihan produk satuan oleh laporan shift: produk katalog (induk) lebih dulu, lalu urut kode */
export const SATUAN_ORDER = [{ familyId: { sort: "asc", nulls: "last" } }, { sku: "asc" }] as const satisfies Prisma.ProductOrderByWithRelationInput[];

export const SINGLE_PACK_VARIANTS: ProductVariant[] = ["HEWAN", "COWOK", "CEWEK", "TRANSPORTASI"];

export type SinglePackPlan = {
  variant: ProductVariant;
  /** ok = sudah benar · move = pindahkan barang laporan dari produk lama ke produk katalog · link = tautkan (barang laporan belum dipegang produk lain) · skip = perlu dicek manual */
  action: "ok" | "move" | "link" | "skip";
  family?: { id: string; sku: string; name: string; itemId: string | null; itemSku?: string };
  /** Barang yang dipakai laporan shift */
  target?: { itemId: string; itemSku: string; ownerId?: string; ownerSku?: string; ownerFamily: boolean };
  note: string;
  /** Barang Single Pack ganda untuk series ini (sku, nama, produk pemilik) */
  duplicates: string[];
};

export async function planSinglePackLinks(db: Db = prisma): Promise<SinglePackPlan[]> {
  const out: SinglePackPlan[] = [];
  for (const variant of SINGLE_PACK_VARIANTS) {
    const fam = await db.product.findMany({ where: { variant, type: "SATUAN", family: { name: SATUAN_FAMILY } }, include: { finishedItem: { select: { sku: true } } }, orderBy: { sku: "asc" } });
    // Barang yang dipakai laporan shift lama: produk satuan LEPAS (belum masuk induk) atau barang BJ-SAT-<series>
    const legacyProd = await db.product.findFirst({ where: { type: "SATUAN", variant, finishedItemId: { not: null }, familyId: null }, include: { finishedItem: { select: { sku: true } } }, orderBy: { sku: "asc" } });
    const legacyItem = legacyProd?.finishedItemId ? null : await db.item.findUnique({ where: { sku: `BJ-SAT-${variant}` }, select: { id: true, sku: true } });
    const dups = [
      ...(await db.product.findMany({ where: { type: "SATUAN", variant, finishedItemId: { not: null } }, include: { finishedItem: { select: { sku: true } } }, orderBy: { sku: "asc" } })).map((p) => `produk ${p.sku} → barang ${p.finishedItem?.sku}${p.familyId ? " (katalog)" : " (lama)"}`),
      ...((await db.item.findUnique({ where: { sku: `BJ-SAT-${variant}` }, select: { sku: true } })) ? [`barang BJ-SAT-${variant} (dari laporan shift)`] : []),
    ];
    const base = { variant, duplicates: dups };
    if (fam.length !== 1) {
      out.push({ ...base, action: "skip", note: fam.length ? `ada ${fam.length} produk katalog ${variant}; cek manual` : `produk katalog ${variant} belum ada (jalankan npm run katalog:produk)` });
      continue;
    }
    const F = fam[0];
    const family = { id: F.id, sku: F.sku, name: F.name, itemId: F.finishedItemId, itemSku: F.finishedItem?.sku };
    const target = legacyProd?.finishedItemId ? { itemId: legacyProd.finishedItemId, itemSku: legacyProd.finishedItem?.sku ?? "", ownerId: legacyProd.id, ownerSku: legacyProd.sku, ownerFamily: false } : legacyItem ? { itemId: legacyItem.id, itemSku: legacyItem.sku, ownerFamily: false } : undefined;
    if (!target || F.finishedItemId === target.itemId) {
      out.push({ ...base, action: F.finishedItemId ? "ok" : "skip", family, target, note: F.finishedItemId ? "sudah benar" : "belum ada barang jadi untuk series ini" });
      continue;
    }
    const [movLegacy, movCat] = await Promise.all([db.stockMovement.count({ where: { itemId: target.itemId } }), F.finishedItemId ? db.stockMovement.count({ where: { itemId: F.finishedItemId } }) : 0]);
    if (movLegacy === 0) out.push({ ...base, action: "ok", family, target, note: "barang lama tidak punya riwayat stok; laporan baru memakai barang katalog" });
    else if (movCat > 0) out.push({ ...base, action: "skip", family, target, note: `barang lama (${target.itemSku}, ${movLegacy} mutasi) dan barang katalog (${F.finishedItem?.sku}, ${movCat} mutasi) sama-sama punya riwayat stok; cek manual` });
    else if (target.ownerId) out.push({ ...base, action: "move", family, target, note: `pindah: ${F.sku} ← ${target.itemSku} (${movLegacy} mutasi; dilepas dari produk lama ${target.ownerSku})${F.finishedItem ? `; barang katalog lama ${F.finishedItem.sku} dilepas, tidak dihapus` : ""}` });
    else out.push({ ...base, action: "link", family, target, note: `tautkan ${F.sku} ← ${target.itemSku} (${movLegacy} mutasi)${F.finishedItem ? `; barang katalog lama ${F.finishedItem.sku} dilepas, tidak dihapus` : ""}` });
  }
  return out;
}

/** Terapkan rencana (hanya mengubah Product.finishedItemId; tidak menghapus data/stok). Kembalikan jumlah produk diubah. */
export async function applySinglePackLinks(db: Prisma.TransactionClient, plans: SinglePackPlan[]) {
  let n = 0;
  for (const p of plans) {
    if (!p.family || !p.target) continue;
    if (p.action === "move") {
      await db.product.update({ where: { id: p.target.ownerId! }, data: { finishedItemId: null } });
      await db.product.update({ where: { id: p.family.id }, data: { finishedItemId: p.target.itemId } });
      n += 2;
    } else if (p.action === "link") {
      await db.product.update({ where: { id: p.family.id }, data: { finishedItemId: p.target.itemId } });
      n++;
    }
  }
  return n;
}
