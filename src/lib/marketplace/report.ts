import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { n } from "../money";
import { marketplaceBanks, recordedWithdraws } from "./bank";
import { resolveSkuKeys, type SkuResolved } from "./sku";

/** Query laporan marketplace (hanya baca). */
export type Tab = "ALL" | "PIUTANG" | "CAIR" | "BATAL" | "RETUR";
export type OrderFilter = { storeId?: string; channel?: string; from?: string; to?: string; tab?: Tab; q?: string };

export const dayStart = (s: string) => new Date(`${s}T00:00:00+07:00`);
export const dayEnd = (s: string) => new Date(new Date(`${s}T00:00:00+07:00`).getTime() + 86400000);

export function orderWhere(f: OrderFilter, withTab = true): Prisma.MarketplaceOrderWhereInput {
  const w: Prisma.MarketplaceOrderWhereInput[] = [];
  if (f.storeId) w.push({ storeId: f.storeId });
  if (f.channel) w.push({ channel: f.channel });
  if (f.from) w.push({ orderedAt: { gte: dayStart(f.from) } });
  if (f.to) w.push({ orderedAt: { lt: dayEnd(f.to) } });
  if (f.q?.trim()) {
    const q = f.q.trim();
    w.push({ OR: [{ orderNo: { contains: q, mode: "insensitive" } }, { trackingNo: { contains: q, mode: "insensitive" } }, { lines: { some: { OR: [{ sku: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } } }] });
  }
  if (withTab) {
    if (f.tab === "PIUTANG") w.push({ status: "PIUTANG", incomeId: null });
    else if (f.tab === "CAIR") w.push({ status: "PIUTANG", incomeId: { not: null } });
    else if (f.tab === "BATAL") w.push({ status: "BATAL" });
    else if (f.tab === "RETUR") w.push({ OR: [{ status: "RETUR" }, { complaint: true }] });
  }
  return { AND: w };
}

export async function listOrders(f: OrderFilter, take = 300) {
  return prisma.marketplaceOrder.findMany({ where: orderWhere(f), orderBy: [{ orderedAt: "desc" }, { orderNo: "desc" }], take, include: { lines: { orderBy: { sortOrder: "asc" } }, income: true } });
}

export async function orderSummary(f: OrderFilter) {
  const base = orderWhere(f, false);
  const [piutang, cair, retur, count] = await Promise.all([
    prisma.marketplaceOrder.aggregate({ where: { AND: [base, { status: "PIUTANG", incomeId: null }] }, _sum: { total: true }, _count: true }),
    prisma.marketplaceIncome.aggregate({ where: { kind: "ORDER", order: { is: base } }, _sum: { released: true, fees: true }, _count: true }),
    prisma.marketplaceOrder.count({ where: { AND: [base, { OR: [{ status: "RETUR" }, { complaint: true }] }] } }),
    prisma.marketplaceOrder.count({ where: base }),
  ]);
  const [nCair, nBatal] = await Promise.all([prisma.marketplaceOrder.count({ where: { AND: [base, { status: "PIUTANG", incomeId: { not: null } }] } }), prisma.marketplaceOrder.count({ where: { AND: [base, { status: "BATAL" }] } })]);
  return { count, piutang: n(piutang._sum.total), piutangCount: piutang._count, cair: n(cair._sum.released), fees: n(cair._sum.fees), retur, counts: { ALL: count, PIUTANG: piutang._count, CAIR: nCair, BATAL: nBatal, RETUR: retur } };
}

/** Semua kombinasi SKU di pesanan beserta pemetaannya; yang belum dipetakan di atas */
export async function skuOverview() {
  const groups = await prisma.marketplaceOrderLine.groupBy({ by: ["skuKey"], _count: { orderId: true }, _sum: { qty: true } });
  const res = await resolveSkuKeys(groups.map((g) => g.skuKey));
  const samples = await prisma.marketplaceOrderLine.findMany({ where: { skuKey: { in: groups.map((g) => g.skuKey) } }, distinct: ["skuKey"], select: { skuKey: true, sku: true, variation: true, name: true, order: { select: { channel: true } } } });
  const sm = new Map(samples.map((s) => [s.skuKey, s]));
  return groups
    .map((g) => ({ key: g.skuKey, orders: g._count.orderId, qty: g._sum.qty ?? 0, sample: sm.get(g.skuKey), resolved: res.get(g.skuKey) as SkuResolved | undefined }))
    .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || b.orders - a.orders);
}

/** Rekonsiliasi: uang cair (file penghasilan) vs withdraw yang sudah dicatat di Keuangan, per toko & kanal untuk satu periode */
export async function reconcile(f: { storeId?: string; from: string; to: string }) {
  const all = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true }, orderBy: { code: "asc" } });
  const stores = f.storeId ? all.filter((s) => s.id === f.storeId) : all;
  const banks = await marketplaceBanks();
  const rows = [];
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      const rel = { gte: dayStart(f.from), lt: dayEnd(f.to) };
      const [cair, ads, adj, wd, rec] = await Promise.all([
        prisma.marketplaceIncome.aggregate({ where: { storeId: s.id, channel: ch, kind: "ORDER", releasedAt: rel }, _sum: { released: true, fees: true }, _count: true }),
        prisma.marketplaceIncome.aggregate({ where: { storeId: s.id, channel: ch, kind: "ADS", releasedAt: rel }, _sum: { released: true } }),
        prisma.marketplaceIncome.aggregate({ where: { storeId: s.id, channel: ch, kind: "ADJUST", releasedAt: rel }, _sum: { released: true } }),
        prisma.marketplaceWithdrawal.findMany({ where: { storeId: s.id, channel: ch, txType: { contains: "withdraw", mode: "insensitive" }, requestedAt: rel }, select: { amount: true, status: true } }),
        recordedWithdraws(s, ch, banks, all.length, rel.gte, rel.lt),
      ]);
      const cairV = n(cair._sum.released), adsV = n(ads._sum.released), adjV = n(adj._sum.released);
      const recorded = rec.rows.reduce((a, x) => a + x.amount, 0);
      if (!cair._count && !recorded && !wd.length && !adsV && !adjV) continue;
      rows.push({ storeId: s.id, store: s.name, channel: ch, orders: cair._count, cair: cairV, ads: adsV, adjust: adjV, tiktokWithdraw: wd.reduce((a, w) => a + Math.abs(n(w.amount)), 0), recorded, diff: cairV + adsV + adjV - recorded, noBank: rec.noBank });
    }
  }
  return rows;
}

/** Laporan wilayah: pesanan, retur, rusak per kota/kab & provinsi; juga per kurir */
export type RegionFilter = OrderFilter & { skuKey?: string; reason?: string };
export async function regionReport(f: RegionFilter) {
  const orders = await prisma.marketplaceOrder.findMany({
    where: { AND: [orderWhere({ ...f, tab: undefined }, false), { status: { not: "BATAL" } }, f.skuKey ? { lines: { some: { skuKey: f.skuKey } } } : {}] },
    select: { city: true, province: true, status: true, complaint: true, returnCaseId: true, courier: true, shipOption: true, lines: { select: { skuKey: true, qty: true, returnQty: true } } },
  });
  const retIds = [...new Set(orders.map((o) => o.returnCaseId).filter((x): x is string => !!x))];
  const rets = retIds.length ? await prisma.returnCase.findMany({ where: { id: { in: retIds } }, select: { id: true, reason: true, lines: { select: { damagedQty: true } } } }) : [];
  const rm = new Map(rets.map((r) => [r.id, { reason: r.reason, damaged: r.lines.reduce((a, l) => a + l.damagedQty, 0) }]));
  type Acc = { orders: number; retur: number; rusak: number };
  const add = (m: Map<string, Acc>, k: string, isRet: boolean, dmg: number) => {
    const a = m.get(k) ?? { orders: 0, retur: 0, rusak: 0 };
    a.orders++;
    if (isRet) a.retur++;
    a.rusak += dmg;
    m.set(k, a);
  };
  const city = new Map<string, Acc>(), prov = new Map<string, Acc>(), courier = new Map<string, Acc>();
  let total = 0, totalRet = 0;
  const damagedByKey = new Map<string, number>();
  for (const o of orders) {
    const r = o.returnCaseId ? rm.get(o.returnCaseId) : undefined;
    if (f.reason && (r?.reason ?? "") !== f.reason) {
      // filter alasan: hanya hitung pesanan yang retur dengan alasan itu; pesanan lain tetap masuk penyebut
      add(city, `${o.city ?? "-"}|${o.province ?? "-"}`, false, 0);
      add(prov, o.province ?? "-", false, 0);
      add(courier, o.courier ?? o.shipOption ?? "-", false, 0);
      total++;
      continue;
    }
    const isRet = o.status === "RETUR" || !!o.returnCaseId;
    const dmg = r?.damaged ?? 0;
    add(city, `${o.city ?? "-"}|${o.province ?? "-"}`, isRet, dmg);
    add(prov, o.province ?? "-", isRet, dmg);
    add(courier, o.courier ?? o.shipOption ?? "-", isRet, dmg);
    total++;
    if (isRet) totalRet++;
    if (dmg) for (const l of o.lines) damagedByKey.set(l.skuKey, (damagedByKey.get(l.skuKey) ?? 0) + dmg);
  }
  const avg = total ? totalRet / total : 0;
  const fmt = (m: Map<string, Acc>, split = false) =>
    [...m.entries()].map(([k, a]) => ({ name: split ? k.split("|")[0] : k, province: split ? k.split("|")[1] : undefined, ...a, pct: a.orders ? (a.retur / a.orders) * 100 : 0, high: a.retur >= 2 && a.retur / a.orders > Math.max(avg * 2, 0.04) })).sort((a, b) => b.orders - a.orders);
  const res = await resolveSkuKeys([...damagedByKey.keys()]);
  const damagedProducts = [...damagedByKey.entries()].map(([key, qty]) => ({ key, qty, name: (res.get(key) as { itemName?: string } | undefined)?.itemName ?? key })).sort((a, b) => b.qty - a.qty).slice(0, 10);
  return { total, totalRet, avgPct: avg * 100, cities: fmt(city, true), provinces: fmt(prov), couriers: fmt(courier), damagedProducts };
}

/** Kota pembeli terbanyak per SKU (untuk produk tertentu) */
export async function topCitiesForProduct(skuKey: string, f: OrderFilter, take = 10) {
  const orders = await prisma.marketplaceOrder.findMany({ where: { AND: [orderWhere({ ...f, tab: undefined }, false), { status: { not: "BATAL" } }, { lines: { some: { skuKey } } }] }, select: { city: true, province: true } });
  const m = new Map<string, number>();
  for (const o of orders) m.set(`${o.city ?? "-"}, ${o.province ?? "-"}`, (m.get(`${o.city ?? "-"}, ${o.province ?? "-"}`) ?? 0) + 1);
  return [...m.entries()].map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders).slice(0, take);
}
