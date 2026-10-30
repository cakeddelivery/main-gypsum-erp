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

export const PACKAGING_CATEGORY = "Kemasan & Packaging";

/** Beban overhead per pcs: biaya per bulan / estimasi output overhead itu (cadangan: kapasitas umum) */
export function overheadUnitCost(o: { monthlyAmount: bigint | number; outputPerMonth: number }, fallbackCapacity = 0) {
  return overheadPerPcs(Number(o.monthlyAmount), o.outputPerMonth || fallbackCapacity);
}

async function capacity(db: DB) {
  return Number((await db.setting.findUnique({ where: { key: "overhead_capacity_pcs" } }))?.value ?? 0) || 0;
}

const laborOf = (rows: { rate: bigint }[]) => rows.reduce((s, r) => s + Number(r.rate), 0);
const overheadOf = (rows: { factor: unknown; overhead: { monthlyAmount: bigint; outputPerMonth: number } }[], cap: number) =>
  Math.round(rows.reduce((s, r) => s + overheadUnitCost(r.overhead, cap) * Number(r.factor), 0));

/**
 * Harga per unit stok tiap item. Barang setengah jadi yang punya resep dihitung dari komponennya
 * (bahan baku atau setengah jadi lain, rekursif) + tenaga kerja + overhead per unit; lainnya dari harga beli terbaru.
 */
export async function itemCosts(db: DB = prisma) {
  const [items, cap] = await Promise.all([
    db.item.findMany({ include: { recipe: true, recipeLabor: true, recipeOverhead: { include: { overhead: true } } } }),
    capacity(db),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const memo = new Map<string, UnitCost>();
  const visit = (id: string, stack: Set<string>): UnitCost => {
    const hit = memo.get(id);
    if (hit) return hit;
    const it = byId.get(id)!;
    const hasRecipe = it.recipe.length + it.recipeLabor.length + it.recipeOverhead.length > 0;
    if (!hasRecipe || stack.has(id)) {
      const r = { cur: latestCost(it), prev: previousCost(it), fromRecipe: false };
      if (!stack.has(id)) memo.set(id, r);
      return r;
    }
    stack.add(id);
    let cur = laborOf(it.recipeLabor) + overheadOf(it.recipeOverhead, cap);
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
  const cap = await capacity(prisma);
  const it = await prisma.item.findUniqueOrThrow({ where: { id: itemId }, include: { recipe: { include: { component: true } }, recipeLabor: true, recipeOverhead: { include: { overhead: true } } } });
  const lines = it.recipe.map((l) => {
    const c = map.get(l.componentId) ?? { cur: 0, prev: 0, fromRecipe: false };
    return { id: l.id, component: l.component, qty: Number(l.qty), useUnit: l.useUnit, unit: recipeUnit(l.component), unitPrice: costPerRecipeUnit(c.cur, l.component), cost: bomLineCost(l.qty, l.component, c.cur), fromRecipe: c.fromRecipe };
  });
  const material = Math.round(lines.reduce((s, l) => s + l.cost, 0));
  const total = map.get(itemId);
  const overheadRows = new Map(it.recipeOverhead.map((o) => [o.id, overheadUnitCost(o.overhead, cap) * Number(o.factor)]));
  return { item: it, lines, material, labor: laborOf(it.recipeLabor), overhead: overheadOf(it.recipeOverhead, cap), overheadRows, hpp: total?.cur ?? 0, trend: trendOf(total?.cur ?? 0, total?.prev ?? 0) };
}

/** Overhead bulanan aktif, kapasitas produksi, dan overhead per pcs */
export async function overheadSummary(db: DB = prisma) {
  const [rows, cap] = await Promise.all([
    db.overhead.findMany({ where: { active: true } }),
    db.setting.findUnique({ where: { key: "overhead_capacity_pcs" } }),
  ]);
  const total = rows.reduce((s, r) => s + Number(r.monthlyAmount), 0);
  const capacity = Number(cap?.value ?? 0) || 0;
  return { total, capacity, perPcs: rows.reduce((s, r) => s + overheadUnitCost(r, capacity), 0), rows: rows.map((r) => ({ ...r, perPcs: overheadUnitCost(r, capacity) })) };
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
  const cap = await capacity(prisma);
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { bom: { include: { item: true } }, recipeLabor: true, recipeOverhead: { include: { overhead: true } } } });
  const unit = (i: Item) => map.get(i.id) ?? { cur: latestCost(i), prev: previousCost(i), fromRecipe: false };
  const lines = p.bom.map((b) => {
    const c = unit(b.item);
    return { id: b.id, item: b.item, qty: Number(b.qty), useUnit: b.useUnit, unit: recipeUnit(b.item), unitPrice: costPerRecipeUnit(c.cur, b.item), cost: bomLineCost(b.qty, b.item, c.cur), prevCost: bomLineCost(b.qty, b.item, c.prev), trend: trendOf(c.cur, c.prev), fromRecipe: c.fromRecipe, packaging: b.item.category === PACKAGING_CATEGORY };
  });
  const sum = (xs: typeof lines, k: "cost" | "prevCost") => Math.round(xs.reduce((s, l) => s + l[k], 0));
  const packaging = sum(lines.filter((l) => l.packaging), "cost") + Number(p.extraPackaging);
  const material = sum(lines.filter((l) => !l.packaging), "cost");
  const prevMaterial = sum(lines, "prevCost") + Number(p.extraPackaging);
  // laborCost/overheadCost lama tetap dihitung (biaya manual di luar baris resep)
  const labor = laborOf(p.recipeLabor) + Number(p.laborCost);
  const overhead = overheadOf(p.recipeOverhead, cap) + Number(p.overheadCost);
  const bookMaterial = await bomMaterialCost(prisma, productId);
  const hpp = calcHpp(material + packaging, labor, overhead);
  const prevHpp = prevMaterial + labor + overhead;
  const overheadRows = new Map(p.recipeOverhead.map((o) => [o.id, overheadUnitCost(o.overhead, cap) * Number(o.factor)]));
  return { material, packaging, labor, overhead, hpp, prevHpp, trend: trendOf(hpp, prevHpp), lines, bookMaterial, recipeLabor: p.recipeLabor, recipeOverhead: p.recipeOverhead, overheadRows, legacy: Number(p.laborCost) + Number(p.overheadCost), product: p };
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

export type RecipeInput = {
  comp: { componentId: string; qty: number; useUnit: string | null }[];
  labor: { taskId: string | null; name: string; rate: number }[];
  oh: { overheadId: string; factor: number }[];
};

/** HPP per unit dari resep yang belum disimpan (dipakai untuk nilai stok awal barang setengah jadi baru) */
export async function draftRecipeCost(r: RecipeInput, db: DB = prisma) {
  const [map, cap, comps, ohs] = await Promise.all([
    itemCosts(db),
    capacity(db),
    db.item.findMany({ where: { id: { in: r.comp.map((c) => c.componentId) } } }),
    db.overhead.findMany({ where: { id: { in: r.oh.map((o) => o.overheadId) } } }),
  ]);
  let total = r.labor.reduce((s, l) => s + l.rate, 0);
  for (const o of r.oh) {
    const m = ohs.find((x) => x.id === o.overheadId);
    if (m) total += overheadUnitCost(m, cap) * o.factor;
  }
  for (const c of r.comp) {
    const it = comps.find((x) => x.id === c.componentId);
    if (it) total += bomLineCost(c.qty, it, map.get(it.id)?.cur ?? latestCost(it));
  }
  return Math.round(total);
}
