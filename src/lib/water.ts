import type { Prisma, PrismaClient } from "@prisma/client";
import { nextItemSku } from "./items";
import { categoryPrefixOf, itemCategories } from "./itemCategories";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Air sebagai bahan baku resep Patung Kering (pengganti "Karakter gypsum / rasio air" yang disembunyikan).
 * Satuan stok liter, satuan resep ml (1 liter = 1000 ml). Harga Rp0: biaya PDAM masuk HPP lewat Overhead "Air PDAM"
 * (dipilih di resep Patung Kering) agar tidak dihitung dua kali. Tidak diopname & tidak memicu permintaan stok (batas minimum 0, tanpa divisi).
 */
export const WATER_NAME = "Air";

export async function ensureWaterItem(db: Db) {
  const ex = await db.item.findFirst({ where: { type: "BAHAN_BAKU", name: { equals: WATER_NAME, mode: "insensitive" } }, orderBy: { active: "desc" } });
  if (ex) return { item: ex, created: false };
  const cats = await itemCategories(db);
  const category = cats.BAHAN_BAKU[0]?.name ?? null;
  const prefix = await categoryPrefixOf(db, "BAHAN_BAKU", category);
  const item = await db.item.create({
    data: { sku: await nextItemSku(db as Prisma.TransactionClient, prefix), name: WATER_NAME, type: "BAHAN_BAKU", unit: "liter", hppUnit: "ml", hppFactor: 1000, category, note: "Air untuk adonan gypsum (resep Patung Kering), hanya mencatat rasio gypsum:air. Biarkan Rp0: biaya PDAM masuk HPP lewat Overhead \"Air PDAM\" agar tidak dihitung dua kali." },
  });
  return { item, created: true };
}

/** Tambahkan Air `ml` per patung ke resep patung kering (SJ-PTG-…) yang belum memakai Air */
export async function addWaterToKeringRecipes(db: Db, waterId: string, ml: number) {
  if (!(ml > 0)) return [];
  const kering = await db.item.findMany({ where: { sku: { startsWith: "SJ-PTG-" }, type: "BARANG_DALAM_PROSES", recipe: { none: { componentId: waterId } } }, orderBy: { sku: "asc" } });
  for (const k of kering) await db.itemRecipeLine.create({ data: { itemId: k.id, componentId: waterId, qty: ml, useUnit: "ml" } });
  return kering.map((k) => ({ sku: k.sku, name: k.name }));
}
