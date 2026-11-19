import { prisma } from "./db";
import { jakartaParts } from "./time";
import { issueLabel } from "./complaintShared";
import { marketplaceLabel } from "./returnLabel";

/**
 * Analitik Retur & Komplain. Kerugian = barang retur rusak/tidak ada (harga pokok) + refund dibayar + barang pengganti
 * + ongkir yang ditanggung toko. Klaim cair ditampilkan terpisah sebagai pengurang (kerugian bersih).
 * Rasio = kerugian ÷ penjualan (akun 4-1000 + 4-1100) di periode yang sama.
 */
export type ALine = { itemId: string | null; itemName: string | null; sku: string | null; variation: string | null; qty: number; bad: number; loss: number };
export type AEvent = {
  kind: "RETUR" | "KOMPLAIN";
  number: string;
  date: Date;
  marketplace: string | null;
  courier: string | null;
  city: string | null;
  province: string | null;
  reason: string;
  /** Barang rusak/hilang (retur) atau barang pengganti (komplain), harga pokok */
  goods: number;
  refund: number;
  shipping: number;
  claim: number;
  lines: ALine[];
};
export type GroupRow = { key: string; label: string; returns: number; complaints: number; qty: number; bad: number; loss: number };
export type MonthRow = { month: string; returns: number; complaints: number; goods: number; refund: number; shipping: number; loss: number; claim: number; sales: number; ratio: number | null };

export const monthKey = (d: Date) => {
  const p = jakartaParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
};
export const lossOf = (e: Pick<AEvent, "goods" | "refund" | "shipping">) => e.goods + e.refund + e.shipping;
const ratio = (loss: number, sales: number) => (sales > 0 ? Math.round((loss / sales) * 10000) / 100 : null);

function group(events: AEvent[], keyOf: (e: AEvent) => [string, string] | null): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const e of events) {
    const k = keyOf(e);
    if (!k) continue;
    const g = m.get(k[0]) ?? { key: k[0], label: k[1], returns: 0, complaints: 0, qty: 0, bad: 0, loss: 0 };
    if (e.kind === "RETUR") g.returns++;
    else g.complaints++;
    g.qty += e.lines.reduce((s, l) => s + l.qty, 0);
    g.bad += e.lines.reduce((s, l) => s + l.bad, 0);
    g.loss += lossOf(e);
    m.set(k[0], g);
  }
  return [...m.values()].sort((a, b) => b.loss - a.loss || b.returns + b.complaints - (a.returns + a.complaints));
}

/** Per baris barang (produk ERP / SKU+variasi label): kerugian dibagi ke baris; ongkir dibagi menurut jumlah barang */
function groupLines(events: AEvent[], keyOf: (l: ALine) => [string, string] | null): GroupRow[] {
  const m = new Map<string, GroupRow & { seen: Set<string> }>();
  for (const e of events) {
    const totalQty = e.lines.reduce((s, l) => s + l.qty, 0) || 1;
    for (const l of e.lines) {
      const k = keyOf(l);
      if (!k) continue;
      const g = m.get(k[0]) ?? { key: k[0], label: k[1], returns: 0, complaints: 0, qty: 0, bad: 0, loss: 0, seen: new Set<string>() };
      if (!g.seen.has(e.number)) {
        g.seen.add(e.number);
        if (e.kind === "RETUR") g.returns++;
        else g.complaints++;
      }
      g.qty += l.qty;
      g.bad += l.bad;
      g.loss += l.loss + Math.round((e.shipping * l.qty) / totalQty);
      m.set(k[0], g);
    }
  }
  return [...m.values()].map(({ seen: _seen, ...g }) => g).sort((a, b) => b.loss - a.loss || b.bad - a.bad);
}

/** Ringkasan, tren bulanan, dan pengelompokan (murni: diuji di tests/retur3analitik.test.ts) */
export function analyze(events: AEvent[], salesByMonth: Map<string, number>, months: string[]) {
  const sum = (f: (e: AEvent) => number) => events.reduce((s, e) => s + f(e), 0);
  const sales = months.reduce((s, m) => s + (salesByMonth.get(m) ?? 0), 0);
  const totals = {
    returns: events.filter((e) => e.kind === "RETUR").length,
    complaints: events.filter((e) => e.kind === "KOMPLAIN").length,
    goods: sum((e) => e.goods),
    refund: sum((e) => e.refund),
    shipping: sum((e) => e.shipping),
    loss: sum(lossOf),
    claim: sum((e) => e.claim),
    sales,
  };
  const monthly: MonthRow[] = months.map((month) => {
    const es = events.filter((e) => monthKey(e.date) === month);
    const loss = es.reduce((s, e) => s + lossOf(e), 0);
    const s = salesByMonth.get(month) ?? 0;
    return {
      month, returns: es.filter((e) => e.kind === "RETUR").length, complaints: es.filter((e) => e.kind === "KOMPLAIN").length,
      goods: es.reduce((x, e) => x + e.goods, 0), refund: es.reduce((x, e) => x + e.refund, 0), shipping: es.reduce((x, e) => x + e.shipping, 0),
      loss, claim: es.reduce((x, e) => x + e.claim, 0), sales: s, ratio: ratio(loss, s),
    };
  });
  return {
    totals: { ...totals, net: totals.loss - totals.claim, ratio: ratio(totals.loss, sales) },
    monthly,
    byProvince: group(events, (e) => [e.province ?? "-", e.province ?? "(tidak diketahui)"]),
    byCity: group(events, (e) => [`${e.city ?? "-"}|${e.province ?? "-"}`, [e.city ?? "(kota tidak diketahui)", e.province].filter(Boolean).join(", ")]),
    byProduct: groupLines(events, (l) => [l.itemId ?? `?${l.sku ?? l.itemName ?? "-"}`, l.itemName ?? `${l.sku ?? "(tanpa produk)"} (belum dipetakan)`]),
    bySku: groupLines(events, (l) => (l.sku ? [`${l.sku}|${l.variation ?? ""}`, [l.sku, l.variation].filter(Boolean).join(" · ")] : null)),
    byCourier: group(events, (e) => [e.courier ?? "-", e.courier ?? "(tidak diketahui)"]),
    byMarketplace: group(events, (e) => [e.marketplace ?? "-", e.marketplace ? marketplaceLabel(e.marketplace) : "(tidak diketahui)"]),
    byReason: group(events, (e) => [`${e.kind}|${e.reason}`, `${e.kind === "RETUR" ? "Retur" : "Komplain"}: ${e.reason}`]),
  };
}

/** Daftar bulan YYYY-MM dari `from` sampai `to` (inklusif) */
export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}

/** Ambil data dari database untuk rentang [start, end) */
export async function loadReturnAnalytics(start: Date, end: Date) {
  const [returns, complaints, salesRows] = await Promise.all([
    prisma.returnCase.findMany({ where: { cancelledAt: null, receivedAt: { gte: start, lt: end } }, include: { lines: { include: { item: { select: { name: true } }, pieces: { select: { perPack: true } } } } } }),
    // Data rekening pembeli sengaja tidak diambil
    prisma.complaint.findMany({
      where: { cancelledAt: null, status: { not: "DITOLAK" }, date: { gte: start, lt: end } },
      select: { number: true, date: true, marketplace: true, courier: true, city: true, province: true, issueType: true, solution: true, refundAmount: true, paidAt: true, replacementValue: true, shippingCost: true, lines: { include: { item: { select: { name: true } } } } },
    }),
    prisma.$queryRaw<{ m: string; v: number }[]>`
      SELECT to_char((j.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM') AS m, COALESCE(SUM(l.credit - l.debit), 0)::float8 AS v
      FROM "JournalLine" l JOIN "Journal" j ON j.id = l."journalId" JOIN "CoaAccount" a ON a.id = l."accountId"
      WHERE a.code IN ('4-1000', '4-1100') AND j.date >= ${start} AND j.date < ${end}
      GROUP BY 1`,
  ]);
  const events: AEvent[] = [
    ...returns.map((r): AEvent => ({
      kind: "RETUR", number: r.number, date: r.receivedAt, marketplace: r.marketplace, courier: r.courier, city: r.city, province: r.province, reason: r.reason ?? "Lainnya",
      goods: Number(r.lossValue), refund: 0, shipping: Number(r.shippingCost), claim: Number(r.claimPaidAmount),
      lines: r.lines.map((l) => {
        const inspected = r.status !== "DITERIMA";
        // Mode pcs: qty & rusak dalam pcs, kerugian dari nilai per pcs yang sudah dihitung saat periksa
        const cap = l.pieceMode ? l.pieces.reduce((a, p) => a + p.perPack, 0) * l.qty : l.qty;
        const bad = inspected ? cap - l.goodQty : 0;
        return { itemId: l.itemId, itemName: l.item?.name ?? null, sku: l.labelSku, variation: l.labelVariation, qty: cap, bad, loss: l.pieceMode ? Number(l.lossValue) : bad * Number(l.unitCost) };
      }),
    })),
    ...complaints.map((c): AEvent => {
      const refund = c.paidAt ? Number(c.refundAmount) : 0;
      const totalQty = c.lines.reduce((s, l) => s + l.qty, 0) || 1;
      return {
        kind: "KOMPLAIN", number: c.number, date: c.date, marketplace: c.marketplace, courier: c.courier, city: c.city, province: c.province, reason: issueLabel(c.issueType),
        goods: Number(c.replacementValue), refund, shipping: Number(c.shippingCost), claim: 0,
        lines: c.lines.map((l) => ({ itemId: l.itemId, itemName: l.item?.name ?? null, sku: l.labelSku, variation: null, qty: l.qty, bad: l.qty, loss: Math.round((refund * l.qty) / totalQty) + l.sendQty * Number(l.unitCost) })),
      };
    }),
  ];
  return { events, salesByMonth: new Map(salesRows.map((r) => [r.m, Number(r.v)])) };
}
