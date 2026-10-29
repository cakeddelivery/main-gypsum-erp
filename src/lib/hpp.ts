import { prisma } from "./db";
import { bomMaterialCost } from "./stock";
import { bomLineCost, costPerRecipeUnit, latestCost, previousCost, recipeUnit, trendOf } from "./unitcost";

export const CHANNELS = ["OFFLINE", "SHOPEE", "TIKTOK_SHOP", "RESELLER"] as const;

export function calcHpp(material: number, labor: number, overhead: number) {
  return material + labor + overhead;
}

export function margin(price: number, hpp: number) {
  const value = price - hpp;
  return { value, pct: price > 0 ? Math.round((value / price) * 1000) / 10 : 0 };
}

/**
 * HPP realtime: bahan dihitung dari harga beli terbaru (bukan rata-rata), sehingga kenaikan harga bahan
 * langsung terlihat. `prevHpp` memakai harga beli sebelumnya untuk indikator naik/turun/tetap.
 * `bookMaterial` = nilai bahan versi akuntansi (harga rata-rata) yang dipakai jurnal produksi.
 */
export async function productCosting(productId: string) {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { bom: { include: { item: true } } } });
  const labor = Number(p.laborCost);
  const overhead = Number(p.overheadCost);
  const lines = p.bom.map((b) => {
    const cur = latestCost(b.item);
    const prev = previousCost(b.item);
    return { id: b.id, item: b.item, qty: Number(b.qty), unit: recipeUnit(b.item), unitPrice: costPerRecipeUnit(cur, b.item), cost: bomLineCost(b.qty, b.item, cur), prevCost: bomLineCost(b.qty, b.item, prev), trend: trendOf(cur, prev) };
  });
  const material = Math.round(lines.reduce((s, l) => s + l.cost, 0));
  const prevMaterial = Math.round(lines.reduce((s, l) => s + l.prevCost, 0));
  const bookMaterial = await bomMaterialCost(prisma, productId);
  const hpp = calcHpp(material, labor, overhead);
  const prevHpp = calcHpp(prevMaterial, labor, overhead);
  return { material, labor, overhead, hpp, prevHpp, trend: trendOf(hpp, prevHpp), lines, bookMaterial };
}

/** Harga terbaru per kanal */
export async function latestPrices(productId: string) {
  const hist = await prisma.priceHistory.findMany({ where: { productId }, orderBy: { effectiveAt: "desc" } });
  const latest = new Map<string, (typeof hist)[number]>();
  for (const h of hist) if (!latest.has(h.channel)) latest.set(h.channel, h);
  return { latest, history: hist };
}
