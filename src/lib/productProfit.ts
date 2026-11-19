import "server-only";
import type { ProductionStage } from "@prisma/client";
import { prisma } from "./db";
import { CHANNELS, feeConfig, itemCosts, productCosting } from "./hpp";
import { channelParams, priceBreakdown } from "./pricing";
import { STAGES } from "./stock";
import { catalogLines, isTemplate, type ReportTemplate, type WorkData } from "./shiftReport";
import { cetakOf, giftboxOf, ovenOf, packingOf } from "./alurProduksi";

export type ProfitRow = {
  productId: string;
  sku: string;
  name: string;
  /** Jumlah jadi = hasil baik pada tahap paling akhir yang tercatat di periode (biasanya Barang Jadi) */
  qtyDone: number;
  doneStage: ProductionStage;
  qtyReject: number;
  rejectRate: number;
  hpp: number;
  /** Nilai bahan per pcs (versi akuntansi), dipakai menilai rugi reject */
  materialUnit: number;
  price: number | null;
  profitUnit: number | null;
  profit: number | null;
  rejectLoss: number;
  net: number | null;
};

/** Hasil baik dari tahap paling akhir yang ada datanya: produk yang belum sampai tahap Barang Jadi tetap terhitung */
export function doneQty(byStage: Map<ProductionStage, number>) {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const q = byStage.get(STAGES[i]);
    if (q != null) return { stage: STAGES[i], qty: q };
  }
  return { stage: STAGES[STAGES.length - 1], qty: 0 };
}

export const rate = (reject: number, good: number) => (reject + good > 0 ? Math.round((reject / (reject + good)) * 1000) / 10 : 0);

/**
 * Perkiraan laba per produk: jumlah jadi × laba bersih per pcs dari harga jual resep (kanal terpilih,
 * setelah potongan marketplace/affiliate/iklan) dikurangi rugi reject (reject × nilai bahan per pcs).
 * Ini PERKIRAAN, bukan penjualan nyata: menganggap semua hasil jadi laku dengan harga resep.
 */
/** Hasil per produk dari Laporan Shift (Packing/Giftbox, katalog SKU) dan reject per barang jadi dari Reject produksi — bukan input manual */
async function reportResults(range: { start: Date; end: Date }) {
  const reports = await prisma.shiftReport.findMany({
    where: { date: { gte: range.start, lt: range.end }, status: { not: "DRAFT" } },
    select: { id: true, work: true, divisionId: true, division: { select: { reportTemplate: true } } },
  });
  const done = new Map<string, number>();
  for (const r of reports) {
    if (r.division.reportTemplate !== "PACKING" && r.division.reportTemplate !== "GIFTBOX") continue;
    for (const key of ["pk", "st", "gb"]) for (const l of catalogLines(r.work as WorkData, key)) done.set(l.productId, (done.get(l.productId) ?? 0) + l.qty);
  }
  const rejects = await prisma.productionReject.findMany({ where: { reportId: { in: reports.map((r) => r.id) } }, select: { itemId: true, qty: true } });
  const prods = await prisma.product.findMany({ where: { finishedItemId: { in: [...new Set(rejects.map((x) => x.itemId))] } }, select: { id: true, finishedItemId: true } });
  const reject = new Map<string, number>();
  for (const x of rejects) {
    const p = prods.find((q) => q.finishedItemId === x.itemId);
    if (p) reject.set(p.id, (reject.get(p.id) ?? 0) + Number(x.qty));
  }
  return { done, reject, reports };
}

export async function productProfit(range: { start: Date; end: Date }, channel: string) {
  const [res, fees, costs, prices] = await Promise.all([
    reportResults(range),
    feeConfig(),
    itemCosts(),
    prisma.priceHistory.findMany({ where: { channel }, orderBy: { effectiveAt: "desc" } }),
  ]);
  const latest = new Map<string, bigint>();
  for (const p of prices) if (!latest.has(p.productId)) latest.set(p.productId, p.price);
  const ids = [...new Set([...res.done.keys(), ...res.reject.keys()])];
  const rows: ProfitRow[] = [];
  for (const id of ids) {
    const qtyDone = res.done.get(id) ?? 0;
    const reject = res.reject.get(id) ?? 0;
    const c = await productCosting(id, costs);
    const p = c.product;
    const priceRaw = latest.get(id);
    const price = priceRaw != null ? Number(priceRaw) : null;
    const params = channelParams(channel, c.hpp, fees, { affiliatePct: Number(p.affiliatePct), adsPct: Number(p.adsPct), itemsPerOrder: Number(p.itemsPerOrder) || 1 });
    const profitUnit = price != null ? priceBreakdown(price, params).profit : null;
    const profit = profitUnit != null ? profitUnit * qtyDone : null;
    const rejectLoss = c.bookMaterial * reject;
    rows.push({
      productId: id, sku: p.sku, name: p.name, qtyDone, doneStage: "BARANG_JADI", qtyReject: reject, rejectRate: rate(reject, qtyDone),
      hpp: c.hpp, materialUnit: c.bookMaterial, price, profitUnit, profit, rejectLoss, net: profit != null ? profit - rejectLoss : null,
    });
  }
  rows.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  return { rows, channels: CHANNELS };
}

/** Nama tahap Alur Produksi (kunci = tahap reject produksi) */
export const STAGE_NAME: Record<string, string> = { CETAK: "Cetak", OVEN: "Oven", ASSEMBLING: "Assembling / Borongan", PACKING: "Packing", GIFTBOX: "Giftbox" };

/** Rincian reject periode dari Laporan Shift: per tahap, penyebab, dan divisi (per karyawan tidak lagi tersedia karena laporan mencatat per divisi) */
export async function rejectBreakdown(range: { start: Date; end: Date }) {
  const { reports } = await reportResults(range);
  const rj = await prisma.productionReject.findMany({ where: { reportId: { in: reports.map((r) => r.id) } }, select: { stage: true, reason: true, qty: true, divisionId: true } });
  const good = new Map<string, number>();
  const bad = new Map<string, number>();
  const byDivGood = new Map<string, number>();
  const byDivBad = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const reason = new Map<string, number>();
  for (const r of reports) {
    if (!isTemplate(r.division.reportTemplate)) continue;
    const x = { template: r.division.reportTemplate as ReportTemplate, work: r.work as WorkData };
    let g = 0;
    if (x.template === "CETAK" || x.template === "PRODUKSI") { const c = cetakOf(x).total; add(good, "CETAK", c); g += c; }
    if (x.template === "PRODUKSI") {
      const o = ovenOf(x);
      add(good, "OVEN", o.good); add(bad, "OVEN", o.reject); add(byDivBad, r.divisionId, o.reject); g += o.good;
      if (o.reject) add(reason, "Reject panen oven", o.reject);
    }
    if (x.template === "PACKING") { const p = packingOf(x).patung; add(good, "PACKING", p); g += p; }
    if (x.template === "GIFTBOX") { const q = giftboxOf(x).box; add(good, "GIFTBOX", q); g += q; }
    add(byDivGood, r.divisionId, g);
  }
  for (const x of rj) {
    const q = Number(x.qty);
    add(bad, x.stage, q); add(byDivBad, x.divisionId, q); add(reason, x.reason, q);
  }
  const divs = await prisma.division.findMany({ where: { id: { in: [...new Set([...byDivGood.keys(), ...byDivBad.keys()])] } }, select: { id: true, name: true } });
  const row = (label: string, g: number, b: number) => ({ label, good: g, reject: b, rate: rate(b, g) });
  return {
    stage: Object.keys(STAGE_NAME).filter((k) => good.has(k) || bad.has(k)).map((k) => ({ stage: k, ...row(STAGE_NAME[k], good.get(k) ?? 0, bad.get(k) ?? 0) })),
    reason: [...reason.entries()].map(([label, reject]) => ({ label, reject })).sort((a, b) => b.reject - a.reject),
    employee: [] as { label: string; good: number; reject: number; rate: number }[],
    division: [...new Set([...byDivGood.keys(), ...byDivBad.keys()])].map((id) => row(divs.find((d) => d.id === id)?.name ?? "-", byDivGood.get(id) ?? 0, byDivBad.get(id) ?? 0)).sort((a, b) => b.rate - a.rate),
  };
}
