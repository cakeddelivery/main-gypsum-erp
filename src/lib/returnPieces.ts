import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { StockError } from "./stock";
import { bomStockQty } from "./unitcost";

type DB = Prisma.TransactionClient | typeof prisma;

/** Komponen pcs satu paket: Single Pack per karakter beserta isi per 1 paket (mis. Paket 24 Mix = 6 × Hewan/Cowok/Cewek/Transportasi) */
export type PackComponent = { itemId: string; name: string; perPack: number };

export const isSinglePackName = (name: string) => /single\s*pack/i.test(name);

/** Isi paket dari BOM produknya; barang yang bukan paket Single Pack (Giftbox, satuan) → daftar kosong (diperiksa per barang seperti biasa) */
export async function packComponents(db: DB, itemId: string): Promise<PackComponent[]> {
  const item = await db.item.findUnique({
    where: { id: itemId },
    select: { product: { select: { bom: { select: { qty: true, item: { select: { id: true, name: true, hppFactor: true } } } } } } },
  });
  const out: PackComponent[] = [];
  for (const b of item?.product?.bom ?? []) {
    if (!isSinglePackName(b.item.name)) continue;
    const perPack = Math.round(bomStockQty(b.qty, b.item));
    if (perPack > 0) out.push({ itemId: b.item.id, name: b.item.name, perPack });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

export type PieceInput = { itemId: string; goodQty: number; damagedQty: number };

/**
 * Nilai hasil periksa satu baris per pcs (murni). Isi per komponen = perPack × jumlah paket.
 *  - semua pcs baik di semua komponen → paket utuh kembali ke stok paket (allGood);
 *  - selain itu pcs baik masuk stok Single Pack; kerugian = (isi − baik) × harga pokok pcs (rusak + tidak ada di paket).
 */
export function pieceInspection(qty: number, rows: { itemId: string; name?: string; perPack: number; goodQty: number; damagedQty: number; unitCost: number }[]) {
  let good = 0, loss = 0, goodPcs = 0, damagedPcs = 0, capPcs = 0, allGood = true;
  for (const r of rows) {
    const cap = r.perPack * qty;
    if (![r.goodQty, r.damagedQty].every((n) => Number.isInteger(n) && n >= 0)) throw new StockError("Jumlah baik/rusak harus bilangan bulat ≥ 0 (pcs)");
    if (r.goodQty + r.damagedQty > cap) throw new StockError(`Baik + rusak${r.name ? ` ${r.name}` : ""} melebihi isi paket: maks ${cap} pcs`);
    good += r.goodQty * r.unitCost;
    loss += (cap - r.goodQty) * r.unitCost;
    goodPcs += r.goodQty; damagedPcs += r.damagedQty; capPcs += cap;
    if (r.goodQty !== cap) allGood = false;
  }
  return { good: Math.round(good), loss: Math.round(loss), goodPcs, damagedPcs, capPcs, allGood };
}
