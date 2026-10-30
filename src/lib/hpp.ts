import type { Item, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { bomMaterialCost } from "./stock";
import { bomLineCost, costPerRecipeUnit, latestCost, previousCost, recipeUnit, trendOf } from "./unitcost";
import { channelParams, overheadPerPcs, parseFees, priceBreakdown, suggestPrice, type FeeConfig } from "./pricing";

type DB = Prisma.TransactionClient | typeof prisma;

export const CHANNELS = ["OFFLINE", "SHOPEE", "TIKTOK_SHOP", "RESELLER"] as const;

export function calcHpp(material: number, labor: number, overhead: number) {
  return material + labor + overhead;
}

export function margin(price: number, hpp: number) {
  const value = price - hpp;
  return { value, pct: price > 0 ? Math.round((value / price) * 1000) / 10 : 0 };
}

export type UnitCost = { cur: number; prev: number; fromRecipe: boolean };

/**
 * Harga per unit stok tiap item. Barang setengah jadi yang punya resep dihitung dari komponennya
 * (bahan baku atau setengah jadi lain, rekursif) + upah + overhead per unit; lainnya dari harga beli terbaru.
 */
export async function itemCosts(db: DB = prisma) {
  const items = await db.item.findMany({ include: { recipe: true } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const memo = new Map<string, UnitCost>();
  const visit = (id: string, stack: Set<string>): UnitCost => {
    const hit = memo.get(id);
    if (hit) return hit;
    const it = byId.get(id)!;
    if (!it.recipe.length || stack.has(id)) {
      const r = { cur: latestCost(it), prev: previousCost(it), fromRecipe: false };
      if (!stack.has(id)) memo.set(id, r);
      return r;
    }
    stack.add(id);
    let cur = Number(it.laborCost) + Number(it.overheadCost);
    let prev = cur;
    for (const l of it.recipe) {
      const comp = byId.get(l.componentId);
      if (!comp) continue;
      const c = visit(comp.id, stack);
      cur += bomLineCost(l.qty, comp, c.cur);
      prev += bomLineCost(l.qty, comp, c.prev);
    }
    stack.delete(id);
    const r = { cur: Math.round(cur), prev: Math.round(prev), fromRecipe: true };
    memo.set(id, r);
    return r;
  };
  for (const i of items) visit(i.id, new Set());
  return memo;
}

/** true bila `componentId` (atau komponen di dalamnya) memakai `itemId`, sehingga resep jadi melingkar */
export async function createsCycle(db: DB, itemId: string, componentId: string) {
  if (itemId === componentId) return true;
  const lines = await db.itemRecipeLine.findMany();
  const uses = new Map<string, string[]>();
  for (const l of lines) uses.set(l.itemId, [...(uses.get(l.itemId) ?? []), l.componentId]);
  const seen = new Set<string>();
  const stack = [componentId];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === itemId) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(uses.get(x) ?? []));
  }
  return false;
}

/** Rincian resep satu barang setengah jadi */
export async function recipeCosting(itemId: string, costs?: Map<string, UnitCost>) {
  const map = costs ?? (await itemCosts());
  const it = await prisma.item.findUniqueOrThrow({ where: { id: itemId }, include: { recipe: { include: { component: true } } } });
  const lines = it.recipe.map((l) => {
    const c = map.get(l.componentId) ?? { cur: 0, prev: 0, fromRecipe: false };
    return { id: l.id, component: l.component, qty: Number(l.qty), unit: recipeUnit(l.component), unitPrice: costPerRecipeUnit(c.cur, l.component), cost: bomLineCost(l.qty, l.component, c.cur), fromRecipe: c.fromRecipe };
  });
  const material = Math.round(lines.reduce((s, l) => s + l.cost, 0));
  const total = map.get(itemId);
  return { item: it, lines, material, labor: Number(it.laborCost), overhead: Number(it.overheadCost), hpp: total?.cur ?? 0, trend: trendOf(total?.cur ?? 0, total?.prev ?? 0) };
}

/** Overhead bulanan aktif, kapasitas produksi, dan overhead per pcs */
export async function overheadSummary(db: DB = prisma) {
  const [rows, cap] = await Promise.all([
    db.overhead.findMany({ where: { active: true } }),
    db.setting.findUnique({ where: { key: "overhead_capacity_pcs" } }),
  ]);
  const total = rows.reduce((s, r) => s + Number(r.monthlyAmount), 0);
  const capacity = Number(cap?.value ?? 0) || 0;
  return { total, capacity, perPcs: overheadPerPcs(total, capacity) };
}

export async function feeConfig(db: DB = prisma): Promise<FeeConfig> {
  return parseFees((await db.setting.findUnique({ where: { key: "marketplace_fees" } }))?.value);
}

/**
 * HPP realtime: bahan dihitung dari harga beli terbaru (bukan rata-rata), sehingga kenaikan harga bahan
 * langsung terlihat; barang setengah jadi di BOM memakai HPP resepnya. `prevHpp` memakai harga beli sebelumnya
 * untuk indikator naik/turun/tetap. `bookMaterial` = nilai bahan versi akuntansi (harga rata-rata) untuk jurnal produksi.
 */
export async function productCosting(productId: string, costs?: Map<string, UnitCost>) {
  const map = costs ?? (await itemCosts());
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { bom: { include: { item: true } } } });
  const labor = Number(p.laborCost);
  const overhead = Number(p.overheadCost);
  const unit = (i: Item) => map.get(i.id) ?? { cur: latestCost(i), prev: previousCost(i), fromRecipe: false };
  const lines = p.bom.map((b) => {
    const c = unit(b.item);
    return { id: b.id, item: b.item, qty: Number(b.qty), unit: recipeUnit(b.item), unitPrice: costPerRecipeUnit(c.cur, b.item), cost: bomLineCost(b.qty, b.item, c.cur), prevCost: bomLineCost(b.qty, b.item, c.prev), trend: trendOf(c.cur, c.prev), fromRecipe: c.fromRecipe };
  });
  const material = Math.round(lines.reduce((s, l) => s + l.cost, 0));
  const prevMaterial = Math.round(lines.reduce((s, l) => s + l.prevCost, 0));
  const bookMaterial = await bomMaterialCost(prisma, productId);
  const hpp = calcHpp(material, labor, overhead);
  const prevHpp = calcHpp(prevMaterial, labor, overhead);
  return { material, labor, overhead, hpp, prevHpp, trend: trendOf(hpp, prevHpp), lines, bookMaterial };
}

/** Saran harga per kanal sesuai target margin, plus laba bersih harga yang berlaku sekarang */
export function channelPricing(
  p: { targetMargin: unknown; affiliatePct: unknown; adsPct: unknown; itemsPerOrder: unknown },
  hpp: number,
  fees: FeeConfig,
  current: Map<string, { price: bigint }>,
) {
  const prod = { affiliatePct: Number(p.affiliatePct), adsPct: Number(p.adsPct), itemsPerOrder: Number(p.itemsPerOrder) || 1 };
  return CHANNELS.map((channel) => {
    const params = channelParams(channel, hpp, fees, prod);
    const suggested = suggestPrice({ ...params, marginPct: Number(p.targetMargin) });
    const cur = current.get(channel);
    return { channel, params, suggested, suggestedBreakdown: suggested ? priceBreakdown(suggested, params) : null, current: cur ? priceBreakdown(Number(cur.price), params) : null };
  });
}

/** Harga terbaru per kanal */
export async function latestPrices(productId: string) {
  const hist = await prisma.priceHistory.findMany({ where: { productId }, orderBy: { effectiveAt: "desc" } });
  const latest = new Map<string, (typeof hist)[number]>();
  for (const h of hist) if (!latest.has(h.channel)) latest.set(h.channel, h);
  return { latest, history: hist };
}
