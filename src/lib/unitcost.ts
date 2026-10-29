/**
 * Konversi satuan & harga bahan untuk HPP.
 * Stok dihitung dalam `unit` item (mis. sak); resep/BOM boleh memakai `hppUnit` (mis. gram)
 * dengan `hppFactor` = jumlah hppUnit dalam 1 unit stok (1 sak gypsum = 18000 gram).
 */
type Num = number | bigint | { toString(): string };
const n = (v: Num | null | undefined) => (v === null || v === undefined ? 0 : Number(v.toString()));

export type CostItem = { unit: string; hppUnit?: string | null; hppFactor?: Num | null; avgCost: Num; lastCost?: Num | null; prevCost?: Num | null };

export function factorOf(i: Pick<CostItem, "hppFactor">) {
  const f = n(i.hppFactor);
  return f > 0 ? f : 1;
}

/** Satuan yang dipakai di BOM/HPP */
export function recipeUnit(i: Pick<CostItem, "unit" | "hppUnit">) {
  return i.hppUnit?.trim() || i.unit;
}

/** Qty BOM (dalam satuan resep) → qty stok (dalam unit stok) */
export function bomStockQty(qty: Num, i: Pick<CostItem, "hppFactor">) {
  return n(qty) / factorOf(i);
}

/** Harga beli terbaru per unit stok (fallback harga rata-rata bila belum pernah dibeli) */
export function latestCost(i: CostItem) {
  return n(i.lastCost) > 0 ? n(i.lastCost) : n(i.avgCost);
}

/** Harga beli sebelum pembelian terakhir per unit stok */
export function previousCost(i: CostItem) {
  return n(i.prevCost) > 0 ? n(i.prevCost) : latestCost(i);
}

/** Harga per satuan resep (mis. Rp/gram) */
export function costPerRecipeUnit(costPerStockUnit: number, i: Pick<CostItem, "hppFactor">) {
  return costPerStockUnit / factorOf(i);
}

export type Trend = { dir: "NAIK" | "TURUN" | "TETAP"; diff: number; pct: number };

export function trendOf(current: number, previous: number): Trend {
  const diff = Math.round(current - previous);
  const pct = previous > 0 ? Math.round((diff / previous) * 1000) / 10 : 0;
  return { dir: diff > 0 ? "NAIK" : diff < 0 ? "TURUN" : "TETAP", diff, pct };
}

/** Biaya bahan satu baris BOM dengan harga tertentu per unit stok */
export function bomLineCost(qty: Num, i: Pick<CostItem, "hppFactor">, costPerStockUnit: number) {
  return bomStockQty(qty, i) * costPerStockUnit;
}

/** Format harga per satuan resep; harga kecil (Rp/gram) ditampilkan dengan desimal */
export function fmtUnitPrice(v: number) {
  return `Rp ${v.toLocaleString("id-ID", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
}
