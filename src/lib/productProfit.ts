import "server-only";
import type { ProductionStage } from "@prisma/client";
import { prisma } from "./db";
import { CHANNELS, feeConfig, itemCosts, productCosting } from "./hpp";
import { channelParams, priceBreakdown } from "./pricing";
import { STAGES } from "./stock";

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
export async function productProfit(range: { start: Date; end: Date }, channel: string) {
  const where = { date: { gte: range.start, lt: range.end } };
  const [grouped, fees, costs, prices] = await Promise.all([
    prisma.productionEntry.groupBy({ by: ["productId", "stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
    feeConfig(),
    itemCosts(),
    prisma.priceHistory.findMany({ where: { channel }, orderBy: { effectiveAt: "desc" } }),
  ]);
  const latest = new Map<string, bigint>();
  for (const p of prices) if (!latest.has(p.productId)) latest.set(p.productId, p.price);
  const ids = [...new Set(grouped.map((g) => g.productId))];
  const rows: ProfitRow[] = [];
  for (const id of ids) {
    const mine = grouped.filter((g) => g.productId === id);
    const done = doneQty(new Map(mine.map((g) => [g.stage, g._sum.qtyGood ?? 0])));
    const reject = mine.reduce((s, g) => s + (g._sum.qtyReject ?? 0), 0);
    const c = await productCosting(id, costs);
    const p = c.product;
    const priceRaw = latest.get(id);
    const price = priceRaw != null ? Number(priceRaw) : null;
    const params = channelParams(channel, c.hpp, fees, { affiliatePct: Number(p.affiliatePct), adsPct: Number(p.adsPct), itemsPerOrder: Number(p.itemsPerOrder) || 1 });
    const profitUnit = price != null ? priceBreakdown(price, params).profit : null;
    const profit = profitUnit != null ? profitUnit * done.qty : null;
    const rejectLoss = c.bookMaterial * reject;
    rows.push({
      productId: id, sku: p.sku, name: p.name, qtyDone: done.qty, doneStage: done.stage, qtyReject: reject, rejectRate: rate(reject, done.qty),
      hpp: c.hpp, materialUnit: c.bookMaterial, price, profitUnit, profit, rejectLoss, net: profit != null ? profit - rejectLoss : null,
    });
  }
  rows.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  return { rows, channels: CHANNELS };
}

/** Rincian reject periode: per tahap, penyebab, karyawan, dan divisi */
export async function rejectBreakdown(range: { start: Date; end: Date }) {
  const where = { date: { gte: range.start, lt: range.end } };
  const [byStage, byReason, byEmp, byDiv] = await Promise.all([
    prisma.productionEntry.groupBy({ by: ["stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.productionEntry.groupBy({ by: ["rejectReason"], where: { ...where, qtyReject: { gt: 0 } }, _sum: { qtyReject: true } }),
    prisma.productionEntry.groupBy({ by: ["employeeId"], where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.productionEntry.groupBy({ by: ["divisionId"], where, _sum: { qtyGood: true, qtyReject: true } }),
  ]);
  const [emps, divs] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: byEmp.map((e) => e.employeeId) } }, select: { id: true, name: true } }),
    prisma.division.findMany({ where: { id: { in: byDiv.map((d) => d.divisionId) } }, select: { id: true, name: true } }),
  ]);
  const row = (label: string, s: { qtyGood: number | null; qtyReject: number | null }) => ({ label, good: s.qtyGood ?? 0, reject: s.qtyReject ?? 0, rate: rate(s.qtyReject ?? 0, s.qtyGood ?? 0) });
  return {
    stage: STAGES.filter((s) => byStage.some((b) => b.stage === s)).map((s) => ({ stage: s, ...row(s, byStage.find((b) => b.stage === s)!._sum) })),
    reason: byReason.map((r) => ({ label: r.rejectReason ?? "Tanpa keterangan", reject: r._sum.qtyReject ?? 0 })).sort((a, b) => b.reject - a.reject),
    employee: byEmp.map((e) => row(emps.find((x) => x.id === e.employeeId)?.name ?? "-", e._sum)).filter((r) => r.reject > 0).sort((a, b) => b.rate - a.rate),
    division: byDiv.map((d) => row(divs.find((x) => x.id === d.divisionId)?.name ?? "-", d._sum)).sort((a, b) => b.rate - a.rate),
  };
}
