import type { ItemType, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ITEM_CATEGORIES } from "./itemCatalog";

type DB = Prisma.TransactionClient | typeof prisma;
export type CategoryMap = Record<ItemType, { name: string; prefix: string }[]>;

/** Kategori aktif per jenis item dari Pengaturan; jenis yang belum punya kategori memakai bawaan */
export async function itemCategories(db: DB = prisma, opts: { includeInactive?: boolean } = {}): Promise<CategoryMap> {
  const rows = await db.itemCategory.findMany({ where: opts.includeInactive ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const out = { BAHAN_BAKU: [], BARANG_DALAM_PROSES: [], BARANG_JADI: [] } as CategoryMap;
  for (const r of rows) out[r.type].push({ name: r.name, prefix: r.prefix });
  for (const t of Object.keys(out) as ItemType[]) if (!out[t].length) out[t] = ITEM_CATEGORIES[t];
  return out;
}

/** Awalan kode untuk kategori (termasuk yang nonaktif, supaya item lama tetap konsisten) */
export async function categoryPrefixOf(db: DB, type: ItemType, category?: string | null) {
  const all = await itemCategories(db, { includeInactive: true });
  return all[type].find((c) => c.name === category)?.prefix ?? { BAHAN_BAKU: "BB", BARANG_DALAM_PROSES: "BSJ", BARANG_JADI: "MG" }[type];
}
