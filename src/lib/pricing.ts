/**
 * Saran harga jual & potongan marketplace (dipakai server dan form).
 * Semua persen dihitung dari harga jual.
 */

export const OVERHEAD_CATEGORIES = ["Listrik", "LPG", "Bensin", "Air", "Penyusutan Oven", "Penyusutan Cetakan", "Sewa Tempat", "Wifi & Internet", "Perlengkapan Produksi"] as const;

export type ChannelFee = { fees: { name: string; pct: number }[]; perOrder: number };
export type FeeConfig = Record<string, ChannelFee>;

export const MARKETPLACES = ["SHOPEE", "TIKTOK_SHOP"] as const;
export const CHANNEL_LABEL: Record<string, string> = { OFFLINE: "Offline", SHOPEE: "Shopee", TIKTOK_SHOP: "TikTok Shop", RESELLER: "Reseller" };

export const DEFAULT_FEES: FeeConfig = {
  SHOPEE: { fees: [{ name: "Biaya Admin", pct: 8.25 }, { name: "Biaya Gratis Ongkir Xtra", pct: 6 }], perOrder: 1250 },
  TIKTOK_SHOP: { fees: [{ name: "Komisi Platform", pct: 9.5 }, { name: "Komisi Dinamis", pct: 8 }], perOrder: 1250 },
};

export function parseFees(json: string | null | undefined): FeeConfig {
  try {
    const v = JSON.parse(json ?? "");
    if (v && typeof v === "object") return { ...DEFAULT_FEES, ...v };
  } catch {}
  return DEFAULT_FEES;
}

export const feePct = (c: ChannelFee | undefined) => (c ? c.fees.reduce((s, f) => s + (Number(f.pct) || 0), 0) : 0);

export type PriceParams = {
  hpp: number;
  /** % potongan marketplace (admin, ongkir, komisi) */
  feePct?: number;
  /** Biaya flat per pesanan */
  perOrder?: number;
  /** Rata-rata produk per pesanan; biaya flat dibagi rata */
  itemsPerOrder?: number;
  affiliatePct?: number;
  adsPct?: number;
};

const flatPerItem = (p: PriceParams) => (p.perOrder ?? 0) / Math.max(1, p.itemsPerOrder ?? 1);
const pctTotal = (p: PriceParams) => (p.feePct ?? 0) + (p.affiliatePct ?? 0) + (p.adsPct ?? 0);

/**
 * Harga supaya laba bersih = target margin % dari harga:
 * harga × (1 − potongan% − margin%) = HPP + biaya pesanan per produk. Dibulatkan ke atas Rp100.
 * null bila potongan + margin ≥ 100% (tidak mungkin dicapai).
 */
export function suggestPrice(p: PriceParams & { marginPct: number }) {
  const denom = 1 - (pctTotal(p) + p.marginPct) / 100;
  if (denom <= 0 || p.hpp <= 0) return null;
  return Math.ceil((p.hpp + flatPerItem(p)) / denom / 100) * 100;
}

/** Rincian potongan & laba bersih untuk harga tertentu */
export function priceBreakdown(price: number, p: PriceParams) {
  const fees = Math.round((price * (p.feePct ?? 0)) / 100);
  const affiliate = Math.round((price * (p.affiliatePct ?? 0)) / 100);
  const ads = Math.round((price * (p.adsPct ?? 0)) / 100);
  const flat = Math.round(flatPerItem(p));
  const net = price - fees - affiliate - ads - flat;
  const profit = net - p.hpp;
  return { price, fees, affiliate, ads, flat, net, profit, pct: price > 0 ? Math.round((profit / price) * 1000) / 10 : 0 };
}

/** Parameter potongan per kanal: offline & reseller tanpa potongan; affiliate & iklan hanya di marketplace */
export function channelParams(channel: string, hpp: number, fees: FeeConfig, prod: { affiliatePct: number; adsPct: number; itemsPerOrder: number }): PriceParams {
  const c = fees[channel];
  if (!c) return { hpp };
  return { hpp, feePct: feePct(c), perOrder: c.perOrder, itemsPerOrder: prod.itemsPerOrder, affiliatePct: prod.affiliatePct, adsPct: prod.adsPct };
}

/** Penyusutan per bulan = harga aset / umur (bulan) */
export function monthlyDepreciation(cost: number, months: number) {
  return months > 0 ? Math.round(cost / months) : 0;
}

/** Overhead per pcs = total overhead bulanan / kapasitas produksi per bulan */
export function overheadPerPcs(totalMonthly: number, capacityPcs: number) {
  return capacityPcs > 0 ? Math.round(totalMonthly / capacityPcs) : 0;
}
