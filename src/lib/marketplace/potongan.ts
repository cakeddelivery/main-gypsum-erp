import { prisma } from "../db";
import { audit } from "../audit";
import { n } from "../money";
import { parseFees } from "../pricing";
import { FEE_CATEGORIES, categoryOf, isCounted, normCol, sumFees, type FeeCategory, type FeeTotals } from "./feeMap";
import { platformOf } from "./rules";
import { dayEnd, dayStart } from "./report";
import { resolveSkuKeys } from "./sku";

/** Laporan potongan marketplace (hanya baca, kecuali applyActuals yang mengubah PENGATURAN harga, bukan transaksi). */
export async function feeOverrides() {
  return new Map((await prisma.marketplaceFeeMap.findMany()).map((m) => [`${m.platform}|${m.column}`, m.category]));
}

export type PotonganFilter = { storeId?: string; channel: string; from: string; to: string };

export async function potonganReport(f: PotonganFilter) {
  const platform = platformOf(f.channel);
  const rel = { gte: dayStart(f.from), lt: dayEnd(f.to) };
  const base = { channel: f.channel, ...(f.storeId ? { storeId: f.storeId } : {}), releasedAt: rel };
  const [orders, ads, adj, overrides] = await Promise.all([
    prisma.marketplaceIncome.findMany({ where: { ...base, kind: "ORDER" }, select: { released: true, productAmt: true, feeDetail: true } }),
    prisma.marketplaceIncome.aggregate({ where: { ...base, kind: "ADS" }, _sum: { released: true } }),
    prisma.marketplaceIncome.aggregate({ where: { ...base, kind: "ADJUST" }, _sum: { released: true } }),
    feeOverrides(),
  ]);
  const gross = orders.reduce((a, o) => a + n(o.productAmt), 0);
  const released = orders.reduce((a, o) => a + n(o.released), 0);
  const t = sumFees(platform, orders.map((o) => (o.feeDetail ?? {}) as Record<string, number>), overrides);
  const adsV = n(ads._sum.released);
  const adjV = n(adj._sum.released);
  const byCategory = { ...t.byCategory };
  if (adsV) byCategory.IKLAN = (byCategory.IKLAN ?? 0) + adsV;
  if (adjV) byCategory.PENYESUAIAN = (byCategory.PENYESUAIAN ?? 0) + adjV;
  const explained = gross + t.counted + adsV + adjV;
  return {
    platform, orders: orders.length, gross, released, byCategory, byColumn: t.byColumn, unmapped: t.unmapped,
    ads: adsV, adjust: adjV,
    /** cair − (harga jual + semua potongan): selisih yang belum terjelaskan oleh kolom biaya */
    residual: released - explained,
    rows: Object.entries(byCategory).filter(([, v]) => v).map(([c, v]) => ({ category: c, label: FEE_CATEGORIES[c as keyof typeof FEE_CATEGORIES]?.label ?? c, counted: c in FEE_CATEGORIES ? isCounted(c as FeeCategory, platform) : true, value: v, pct: gross ? (Math.abs(v) / gross) * 100 : 0 })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
  };
}

/** Kolom biaya yang belum dikenal di semua penghasilan (supaya tidak pernah hilang diam-diam) */
export async function unmappedColumns() {
  const overrides = await feeOverrides();
  const out = new Map<string, { platform: "SHOPEE" | "TIKTOK"; column: string; total: number; rows: number }>();
  for (const ch of ["SHP", "TTS"] as const) {
    const platform = platformOf(ch);
    for (const r of await prisma.marketplaceIncome.findMany({ where: { channel: ch, kind: "ORDER" }, select: { feeDetail: true }, take: 20000 })) {
      for (const [col, v] of Object.entries((r.feeDetail ?? {}) as Record<string, number>)) {
        if (categoryOf(platform, col, overrides) !== "BELUM") continue;
        const k = `${platform}|${normCol(col)}`;
        const e = out.get(k) ?? { platform, column: col, total: 0, rows: 0 };
        e.total += v;
        e.rows++;
        out.set(k, e);
      }
    }
  }
  return [...out.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/** Pengaturan harga (src/lib/pricing.ts) ↔ angka aktual per kanal */
const SETTING_CHANNEL: Record<string, string> = { SHP: "SHOPEE", TTS: "TIKTOK_SHOP" };
type Src = { name: string; pick: (t: FeeTotals) => number };
const SOURCES: Record<string, Src[]> = {
  SHP: [{ name: "Biaya Admin", pick: (t) => t.byCategory.ADMIN ?? 0 }, { name: "Biaya Gratis Ongkir Xtra", pick: (t) => t.byCategory.ONGKIR_PROGRAM ?? 0 }],
  TTS: [{ name: "Komisi Platform", pick: (t) => Object.entries(t.byColumn).filter(([c]) => /komisi platform/.test(c)).reduce((a, [, v]) => a + v, 0) }, { name: "Komisi Dinamis", pick: (t) => Object.entries(t.byColumn).filter(([c]) => /komisi dinamis/.test(c)).reduce((a, [, v]) => a + v, 0) }],
};

export async function feeVsSettings(f: PotonganFilter) {
  const rep = await potonganReport(f);
  const cfg = parseFees((await prisma.setting.findUnique({ where: { key: "marketplace_fees" } }))?.value)[SETTING_CHANNEL[f.channel]];
  const totals: FeeTotals = { byCategory: rep.byCategory, byColumn: rep.byColumn, unmapped: rep.unmapped, counted: 0 };
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const settingRows = (SOURCES[f.channel] ?? []).map((s) => {
    const setting = cfg?.fees.find((x) => x.name === s.name)?.pct ?? null;
    const actual = rep.gross ? round2((Math.abs(s.pick(totals)) / rep.gross) * 100) : 0;
    return { name: s.name, setting, actual, diff: setting === null ? null : round2(actual - setting) };
  });
  const perOrderActual = rep.orders ? Math.round(Math.abs(rep.byCategory.PROSES ?? 0) / rep.orders) : 0;
  return { ...rep, settingRows, perOrder: { setting: cfg?.perOrder ?? null, actual: perOrderActual }, enough: rep.orders >= 20 && rep.gross > 0 };
}

/** Tulis angka aktual ke PENGATURAN biaya marketplace (bukan transaksi). Butuh minimal 20 pesanan cair di periode. */
export async function applyActuals(actor: { id: string; name: string }, f: PotonganFilter) {
  const r = await feeVsSettings(f);
  if (!r.enough) throw new Error("Data belum cukup (minimal 20 pesanan cair pada periode ini)");
  const key = SETTING_CHANNEL[f.channel];
  const all = parseFees((await prisma.setting.findUnique({ where: { key: "marketplace_fees" } }))?.value);
  const cur = all[key] ?? { fees: [], perOrder: 0 };
  const fees = [...cur.fees];
  for (const row of r.settingRows) {
    const i = fees.findIndex((x) => x.name === row.name);
    if (i >= 0) fees[i] = { ...fees[i], pct: row.actual };
    else fees.push({ name: row.name, pct: row.actual });
  }
  const next = { ...all, [key]: { fees, perOrder: r.perOrder.actual || cur.perOrder } };
  await prisma.setting.upsert({ where: { key: "marketplace_fees" }, create: { key: "marketplace_fees", value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  await audit(actor, "BIAYA_MARKETPLACE_AKTUAL", "Setting", "marketplace_fees", { channel: f.channel, from: f.from, to: f.to, rows: r.settingRows, perOrder: r.perOrder.actual });
  return next[key];
}

/** Komisi affiliate & iklan aktual per produk (alokasi per pesanan proporsional nilai baris) */
export async function productActuals(f: PotonganFilter & { minOrders?: number }) {
  const platform = platformOf(f.channel);
  const overrides = await feeOverrides();
  const orders = await prisma.marketplaceOrder.findMany({
    where: { channel: f.channel, ...(f.storeId ? { storeId: f.storeId } : {}), incomeId: { not: null }, income: { is: { releasedAt: { gte: dayStart(f.from), lt: dayEnd(f.to) } } }, status: "PIUTANG" },
    select: { income: { select: { feeDetail: true } }, lines: { select: { skuKey: true, amount: true } } },
  });
  const res = await resolveSkuKeys([...new Set(orders.flatMap((o) => o.lines.map((l) => l.skuKey)))]);
  const acc = new Map<string, { itemId: string; name: string; orders: number; gross: number; affiliate: number }>();
  for (const o of orders) {
    const aff = Math.abs(sumFees(platform, [(o.income?.feeDetail ?? {}) as Record<string, number>], overrides).byCategory.AFFILIATE ?? 0);
    const total = o.lines.reduce((a, l) => a + n(l.amount), 0) || 1;
    for (const l of o.lines) {
      const r = res.get(l.skuKey);
      if (r?.kind !== "PRODUK") continue;
      const e = acc.get(r.itemId) ?? { itemId: r.itemId, name: r.itemName, orders: 0, gross: 0, affiliate: 0 };
      e.orders++;
      e.gross += n(l.amount);
      e.affiliate += (aff * n(l.amount)) / total;
      acc.set(r.itemId, e);
    }
  }
  return [...acc.values()].filter((e) => e.orders >= (f.minOrders ?? 10)).map((e) => ({ ...e, affiliatePct: e.gross ? Math.round((e.affiliate / e.gross) * 10000) / 100 : 0 })).sort((a, b) => b.gross - a.gross);
}

/** Terapkan affiliate% aktual ke Produk > Biaya (Product.affiliatePct), per barang jadi yang punya produk */
export async function applyProductAffiliate(actor: { id: string; name: string }, f: PotonganFilter) {
  const rows = await productActuals(f);
  let updated = 0;
  for (const r of rows) {
    const res = await prisma.product.updateMany({ where: { finishedItemId: r.itemId }, data: { affiliatePct: r.affiliatePct } });
    updated += res.count;
  }
  await audit(actor, "AFFILIATE_PCT_AKTUAL", "Product", null, { channel: f.channel, from: f.from, to: f.to, products: updated });
  return updated;
}

/** Laporan affiliate: pesanan affiliate, omzet, komisi per toko/kanal/kreator/produk */
export async function affiliateReport(f: { storeId?: string; channel?: string; from: string; to: string }) {
  const overrides = await feeOverrides();
  const orders = await prisma.marketplaceOrder.findMany({
    where: { ...(f.storeId ? { storeId: f.storeId } : {}), ...(f.channel ? { channel: f.channel } : {}), orderedAt: { gte: dayStart(f.from), lt: dayEnd(f.to) }, status: { not: "BATAL" } },
    select: { channel: true, storeId: true, creatorHandle: true, affiliate: true, total: true, income: { select: { feeDetail: true } }, lines: { select: { skuKey: true, amount: true } } },
  });
  const res = await resolveSkuKeys([...new Set(orders.flatMap((o) => o.lines.map((l) => l.skuKey)))]);
  type Acc = { orders: number; omzet: number; komisi: number };
  const mk = (): Acc => ({ orders: 0, omzet: 0, komisi: 0 });
  const byChannel = new Map<string, Acc>(), byCreator = new Map<string, Acc>(), byProduct = new Map<string, Acc>(), byStore = new Map<string, Acc>();
  const bump = (m: Map<string, Acc>, k: string, omzet: number, komisi: number) => {
    const e = m.get(k) ?? mk();
    e.orders++;
    e.omzet += omzet;
    e.komisi += komisi;
    m.set(k, e);
  };
  let all = 0, aff = mk();
  for (const o of orders) {
    all++;
    const komisi = Math.abs(sumFees(platformOf(o.channel), [(o.income?.feeDetail ?? {}) as Record<string, number>], overrides).byCategory.AFFILIATE ?? 0);
    if (!(o.affiliate || komisi)) continue;
    const omzet = n(o.total);
    aff.orders++;
    aff.omzet += omzet;
    aff.komisi += komisi;
    bump(byChannel, o.channel, omzet, komisi);
    bump(byStore, o.storeId, omzet, komisi);
    bump(byCreator, o.creatorHandle ?? (o.channel === "SHP" ? "(Shopee AMS)" : "(tanpa kreator)"), omzet, komisi);
    const sum = o.lines.reduce((a, l) => a + n(l.amount), 0) || 1;
    for (const l of o.lines) {
      const r = res.get(l.skuKey);
      bump(byProduct, r?.kind === "PRODUK" ? r.itemName : r?.kind === "EXTRA_PACKING" ? `Extra Packing ${r.variant ?? ""}` : l.skuKey, n(l.amount), (komisi * n(l.amount)) / sum);
    }
  }
  const fmt = (m: Map<string, Acc>) => [...m.entries()].map(([name, a]) => ({ name, ...a, pct: a.omzet ? (a.komisi / a.omzet) * 100 : 0 })).sort((a, b) => b.omzet - a.omzet);
  return { totalOrders: all, aff, pctOrders: all ? (aff.orders / all) * 100 : 0, komisiPct: aff.omzet ? (aff.komisi / aff.omzet) * 100 : 0, byChannel: fmt(byChannel), byStore: fmt(byStore), byCreator: fmt(byCreator), byProduct: fmt(byProduct) };
}
