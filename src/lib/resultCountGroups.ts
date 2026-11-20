import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { catalogGrid, familyInclude } from "./productFamily";

export type ResultPlace = { group: string; sub: string; col: string; order: number };

/**
 * Letak barang di tahap "Stok jadi": produk induk → baris katalog (mis. paket "12 pcs") → kolom (series).
 * Barang tanpa produk induk: kelompok "Barang setengah jadi" / "Produk jadi lainnya" tanpa paket/series.
 */
export async function resultPlaces(items: { id: string; type: string }[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Map<string, ResultPlace>> {
  const out = new Map<string, ResultPlace>();
  if (!items.length) return out;
  const products = await db.product.findMany({ where: { finishedItemId: { in: items.map((i) => i.id) }, familyId: { not: null } }, select: { id: true, finishedItemId: true, familyId: true } });
  const familyIds = [...new Set(products.map((p) => p.familyId!))];
  const families = familyIds.length ? await db.productFamily.findMany({ where: { id: { in: familyIds } }, include: familyInclude, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }) : [];
  const itemOfProduct = new Map(products.map((p) => [p.id, p.finishedItemId!]));
  let order = 0;
  for (const f of families) {
    const g = catalogGrid(f);
    for (const row of g.rows) {
      row.cells.forEach((cell, ci) => {
        const itemId = cell ? itemOfProduct.get(cell.productId) : undefined;
        if (itemId) out.set(itemId, { group: f.name, sub: row.label, col: g.cols[ci] ?? cell!.name, order: order++ });
      });
    }
  }
  for (const i of items) {
    if (!out.has(i.id)) out.set(i.id, { group: i.type === "BARANG_DALAM_PROSES" ? "Barang setengah jadi" : "Produk jadi lainnya", sub: "", col: "", order: order++ });
  }
  return out;
}
