import { prisma } from "./db";
import { bomMaterialCost } from "./stock";

export const CHANNELS = ["OFFLINE", "SHOPEE", "TIKTOK_SHOP", "RESELLER"] as const;

export function calcHpp(material: number, labor: number, overhead: number) {
  return material + labor + overhead;
}

export function margin(price: number, hpp: number) {
  const value = price - hpp;
  return { value, pct: price > 0 ? Math.round((value / price) * 1000) / 10 : 0 };
}

export async function productCosting(productId: string) {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  const material = await bomMaterialCost(prisma, productId);
  const labor = Number(p.laborCost);
  const overhead = Number(p.overheadCost);
  return { material, labor, overhead, hpp: calcHpp(material, labor, overhead) };
}

/** Harga terbaru per kanal */
export async function latestPrices(productId: string) {
  const hist = await prisma.priceHistory.findMany({ where: { productId }, orderBy: { effectiveAt: "desc" } });
  const latest = new Map<string, (typeof hist)[number]>();
  for (const h of hist) if (!latest.has(h.channel)) latest.set(h.channel, h);
  return { latest, history: hist };
}
