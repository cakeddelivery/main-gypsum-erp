import { prisma } from "../db";
import { returnCatalog } from "../returns";
import { normSku } from "./rules";

/** Bawaan (konfirmasi pemilik): SKU TikTok "BWPK" = Extra Packing "Extra Dus + Bubble Wrap". Dipakai hanya bila belum ada pemetaan/penandaan sendiri; bisa diubah di Pemetaan SKU. */
export const DEFAULT_EXTRA: Record<string, string> = { "BWPK|": "Extra Dus + Bubble Wrap" };

/**
 * Varian Extra Packing otomatis untuk SKU yang sudah diketahui (bisa diubah di Pemetaan SKU):
 * BWPK (TikTok) = Extra Dus + Bubble Wrap; BBWP (Shopee) menurut nama variasi: "Bubble + Dus" = Extra Dus + Bubble Wrap, "Bubble Wrap" = Bubble Wrap.
 */
export function defaultExtraVariant(key: string): string | null {
  const [s, v = ""] = key.split("|");
  const fixed = DEFAULT_EXTRA[key] ?? DEFAULT_EXTRA[`${s}|`];
  if (fixed) return fixed;
  if (s === "BBWP") {
    const x = v.toLowerCase();
    if (/bubble/.test(x) && /dus/.test(x)) return "Extra Dus + Bubble Wrap";
    if (/bubble/.test(x)) return "Bubble Wrap";
    if (/dus/.test(x)) return "Extra Dus";
  }
  return null;
}

export type SkuResolved =
  | { kind: "PRODUK"; itemId: string; itemName: string; by: "PETA" | "OTOMATIS" }
  | { kind: "EXTRA_PACKING"; variant: string | null };

/**
 * Cari produk ERP / penanda Extra Packing untuk kumpulan kunci "SKU|VARIASI" (sudah dinormalkan).
 * Pemetaan produk memakai tabel yang SAMA dengan menu Retur (MarketplaceSkuMap): kunci lama dari Retur
 * dikenali walau ditulis "MG-12MIX" atau "12 MIX". Tanpa pemetaan: SKU persis sama dengan SKU produk jadi → otomatis.
 */
export async function resolveSkuKeys(keys: string[]): Promise<Map<string, SkuResolved>> {
  const out = new Map<string, SkuResolved>();
  if (!keys.length) return out;
  const [maps, classes, catalog] = await Promise.all([prisma.marketplaceSkuMap.findMany({ include: { item: { select: { name: true } } } }), prisma.marketplaceSkuClass.findMany(), returnCatalog()]);
  const byKey = new Map<string, { itemId: string; name: string }>();
  for (const m of maps) {
    const [s, v] = m.key.split("|");
    byKey.set(`${normSku(s)}|${v ?? ""}`, { itemId: m.itemId, name: m.item.name });
  }
  const cls = new Map(classes.map((c) => [c.key, c]));
  const names = new Map(catalog.map((c) => [c.itemId, c.name]));
  const bySku = new Map<string, string[]>();
  for (const c of catalog) {
    const k = normSku(c.sku);
    bySku.set(k, [...(bySku.get(k) ?? []), c.itemId]);
  }
  for (const key of new Set(keys)) {
    const [s] = key.split("|");
    const c = cls.get(key) ?? cls.get(`${s}|`);
    if (c) {
      out.set(key, { kind: "EXTRA_PACKING", variant: c.variant });
      continue;
    }
    const m = byKey.get(key) ?? byKey.get(`${s}|`);
    if (m) {
      out.set(key, { kind: "PRODUK", itemId: m.itemId, itemName: m.name, by: "PETA" });
      continue;
    }
    const def = defaultExtraVariant(key);
    if (def) {
      out.set(key, { kind: "EXTRA_PACKING", variant: def });
      continue;
    }
    const same = bySku.get(s);
    if (same?.length === 1) out.set(key, { kind: "PRODUK", itemId: same[0], itemName: names.get(same[0]) ?? s, by: "OTOMATIS" });
  }
  return out;
}

export const EXTRA_PACKING_VARIANTS = ["Bubble Wrap", "Extra Dus", "Extra Dus + Bubble Wrap"] as const;
