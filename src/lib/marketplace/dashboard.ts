import { prisma } from "../db";
import { n } from "../money";
import { dayEnd, dayStart, orderSummary } from "./report";
import { potonganReport } from "./potongan";
import { regionCity, CHANNEL_LABEL } from "./rules";
import { resolveSkuKeys } from "./sku";

/** Data dashboard marketplace (hanya baca): omzet harian per kanal, top produk, potongan, kota teratas, ringkasan per toko. */
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
export const monthBounds = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}`, days: last };
};

/** Bulan terbaru yang punya pesanan (bawaan dashboard); bila belum ada data, bulan ini */
export async function latestMonth() {
  const o = await prisma.marketplaceOrder.findFirst({ where: { orderedAt: { not: null } }, orderBy: { orderedAt: "desc" }, select: { orderedAt: true } });
  return wib(o?.orderedAt ?? new Date()).slice(0, 7);
}

export async function dashboardData(f: { month: string; storeId?: string }) {
  const { from, to, days } = monthBounds(f.month);
  const where = { orderedAt: { gte: dayStart(from), lt: dayEnd(to) }, ...(f.storeId ? { storeId: f.storeId } : {}) };
  const [orders, incomes, summary, stores] = await Promise.all([
    prisma.marketplaceOrder.findMany({ where, select: { channel: true, storeId: true, orderedAt: true, total: true, status: true, affiliate: true, city: true, lines: { select: { skuKey: true, qty: true, amount: true } } } }),
    prisma.marketplaceIncomeEvent.findMany({ where: { income: { kind: "ORDER", ...(f.storeId ? { storeId: f.storeId } : {}) }, releasedAt: { gte: dayStart(from), lt: dayEnd(to) } }, select: { releasedAt: true, released: true } }),
    orderSummary({ storeId: f.storeId, from, to }),
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
  ]);
  const live = orders.filter((o) => o.status !== "BATAL");
  // Omzet & pesanan per hari per kanal; cair per hari
  const daily = Array.from({ length: days }, (_, i) => ({ label: String(i + 1).padStart(2, "0"), SHP: 0, TTS: 0, pesananSHP: 0, pesananTTS: 0, cair: 0 }));
  for (const o of live) {
    const d = Number(wib(o.orderedAt!).slice(8)) - 1;
    if (daily[d]) {
      daily[d][o.channel as "SHP" | "TTS"] += n(o.total);
      daily[d][o.channel === "SHP" ? "pesananSHP" : "pesananTTS"]++;
    }
  }
  for (const i of incomes) {
    const d = Number(wib(i.releasedAt!).slice(8)) - 1;
    if (daily[d]) daily[d].cair += n(i.released);
  }
  // Per toko × kanal
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  const key = (o: { storeId: string; channel: string }) => `${o.storeId}|${o.channel}`;
  const perStore = new Map<string, { store: string; channel: string; orders: number; omzet: number; batal: number; retur: number; affiliate: number }>();
  for (const o of orders) {
    const e = perStore.get(key(o)) ?? { store: sn.get(o.storeId) ?? "", channel: o.channel, orders: 0, omzet: 0, batal: 0, retur: 0, affiliate: 0 };
    if (o.status === "BATAL") e.batal++;
    else {
      e.orders++;
      e.omzet += n(o.total);
      if (o.status === "RETUR") e.retur++;
      if (o.affiliate) e.affiliate++;
    }
    perStore.set(key(o), e);
  }
  // Top produk (omzet) & top kota
  const res = await resolveSkuKeys([...new Set(live.flatMap((o) => o.lines.map((l) => l.skuKey)))]);
  const prod = new Map<string, { name: string; qty: number; omzet: number }>();
  for (const o of live) for (const l of o.lines) {
    const r = res.get(l.skuKey);
    const name = r?.kind === "PRODUK" ? r.itemName : r?.kind === "EXTRA_PACKING" ? `Extra Packing${r.variant ? ` · ${r.variant}` : ""}` : l.skuKey.split("|")[0] || "(tanpa SKU)";
    const e = prod.get(name) ?? { name, qty: 0, omzet: 0 };
    e.qty += l.qty;
    e.omzet += n(l.amount);
    prod.set(name, e);
  }
  const city = new Map<string, number>();
  for (const o of live) if (o.city) city.set(regionCity(o.city), (city.get(regionCity(o.city)) ?? 0) + 1);
  // Potongan per kanal untuk bulan itu
  const potongan = await Promise.all((["SHP", "TTS"] as const).map(async (ch) => ({ channel: ch, ...(await potonganReport({ storeId: f.storeId, channel: ch, from, to })) })));
  const omzet = live.reduce((a, o) => a + n(o.total), 0);
  return {
    from, to, summary, omzet, orders: live.length, batal: orders.length - live.length, retur: live.filter((o) => o.status === "RETUR").length,
    avg: live.length ? Math.round(omzet / live.length) : 0,
    daily: daily.map((d) => ({ ...d, SHP: d.SHP, TTS: d.TTS })),
    perStore: [...perStore.values()].sort((a, b) => b.omzet - a.omzet),
    topProducts: [...prod.values()].sort((a, b) => b.omzet - a.omzet).slice(0, 8),
    topCities: [...city.entries()].map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders).slice(0, 8),
    potongan: potongan.filter((p) => p.orders > 0).map((p) => ({ channel: p.channel, label: CHANNEL_LABEL[p.channel], gross: p.gross, released: p.released, counted: p.rows.filter((r) => r.counted).reduce((a, r) => a + r.value, 0), top: p.rows.filter((r) => r.counted).slice(0, 5) })),
  };
}
