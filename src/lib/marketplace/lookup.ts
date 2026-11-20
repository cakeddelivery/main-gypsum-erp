import { prisma } from "../db";
import { n } from "../money";
import { COURIERS, normalizeProvince } from "../returnLabel";
import { returnStatusOf } from "../returns";
import { complaintStatusOf } from "../complaintShared";
import { resolveSkuKeys } from "./sku";
import { platformOf, regionCity } from "./rules";

/**
 * Cari pesanan marketplace untuk form Retur/Komplain: No. Pesanan/Order ID atau No. Resi (diketik, scanner USB, atau hasil
 * scan kamera). Hasilnya dipakai mengisi form otomatis. Tanpa data pribadi pembeli.
 */
export type OrderHit = {
  id: string;
  orderNo: string;
  channel: string;
  storeId: string;
  store: string;
  marketplace: "SHOPEE" | "TIKTOK";
  trackingNo: string | null;
  courier: string | null;
  city: string | null;
  province: string | null;
  total: number;
  status: string;
  lines: { sku: string | null; variation: string | null; name: string | null; qty: number; itemId: string | null; itemName: string | null; extra: boolean }[];
  /** Retur/komplain aktif yang sudah tercatat untuk pesanan ini */
  existing: { returns: { number: string; status: string }[]; complaints: { number: string; status: string }[] };
};

/** Pecah hasil scan/ketikan jadi kandidat kode (QR bisa berisi URL/teks panjang) */
export function queryTokens(q: string): string[] {
  const raw = q.toUpperCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  if (raw) set.add(raw.replace(/\s/g, ""));
  for (const t of raw.split(/[^A-Z0-9]+/)) if (t.length >= 6 && t.length <= 40) set.add(t);
  return [...set].slice(0, 12);
}

/** "SPX Standard" → "SPX", "J&T Express" → "J&T" (daftar kurir yang dikenal Retur) */
export function courierGuess(text: string | null | undefined): string | null {
  const t = (text ?? "").toUpperCase();
  if (!t) return null;
  return [...COURIERS].filter((c) => c !== "Lainnya").sort((a, b) => b.length - a.length).find((c) => t.includes(c.toUpperCase())) ?? null;
}

export async function lookupOrders(q: string, limit = 5): Promise<OrderHit[]> {
  const tokens = queryTokens(q);
  if (!tokens.length) return [];
  const orders = await prisma.marketplaceOrder.findMany({
    where: { OR: [{ orderNo: { in: tokens } }, { trackingNo: { in: tokens } }] },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
    orderBy: { orderedAt: "desc" },
    take: limit,
  });
  if (!orders.length) return [];
  const [res, stores, rets, comps] = await Promise.all([
    resolveSkuKeys([...new Set(orders.flatMap((o) => o.lines.map((l) => l.skuKey)))]),
    prisma.store.findMany({ where: { id: { in: orders.map((o) => o.storeId) } }, select: { id: true, name: true } }),
    prisma.returnCase.findMany({ where: { cancelledAt: null, OR: [{ orderNo: { in: orders.map((o) => o.orderNo) } }, { trackingNo: { in: orders.map((o) => o.trackingNo).filter((x): x is string => !!x) } }] }, select: { number: true, status: true, orderNo: true, trackingNo: true, cancelledAt: true } }),
    prisma.complaint.findMany({ where: { cancelledAt: null, OR: [{ orderNo: { in: orders.map((o) => o.orderNo) } }, { trackingNo: { in: orders.map((o) => o.trackingNo).filter((x): x is string => !!x) } }] }, select: { number: true, status: true, orderNo: true, trackingNo: true, cancelledAt: true } }),
  ]);
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  return orders.map((o) => ({
    id: o.id, orderNo: o.orderNo, channel: o.channel, storeId: o.storeId, store: sn.get(o.storeId) ?? "", marketplace: platformOf(o.channel) === "SHOPEE" ? "SHOPEE" : "TIKTOK",
    trackingNo: o.trackingNo, courier: courierGuess(o.courier ?? o.shipOption), city: o.city ? regionCity(o.city) : null, province: o.province ? normalizeProvince(o.province) ?? regionCity(o.province) : null,
    total: n(o.total), status: o.status,
    lines: o.lines.map((l) => {
      const r = res.get(l.skuKey);
      return { sku: l.sku, variation: l.variation, name: l.name, qty: l.qty, itemId: r?.kind === "PRODUK" ? r.itemId : null, itemName: r?.kind === "PRODUK" ? r.itemName : null, extra: r?.kind === "EXTRA_PACKING" };
    }),
    existing: {
      returns: rets.filter((r) => r.orderNo === o.orderNo || (o.trackingNo && r.trackingNo === o.trackingNo)).map((r) => ({ number: r.number, status: returnStatusOf(r).label })),
      complaints: comps.filter((c) => c.orderNo === o.orderNo || (o.trackingNo && c.trackingNo === o.trackingNo)).map((c) => ({ number: c.number, status: complaintStatusOf(c).label })),
    },
  }));
}

/** Pesanan berstatus Retur/Komplain di file yang belum punya catatan di menu Retur/Komplain */
export async function unloggedCounts(f: { storeId?: string; channel?: string }) {
  const base = { ...(f.storeId ? { storeId: f.storeId } : {}), ...(f.channel ? { channel: f.channel } : {}) };
  const [fromFile, logged] = await Promise.all([
    prisma.marketplaceOrder.count({ where: { ...base, status: "RETUR" } }),
    prisma.marketplaceOrder.count({ where: { ...base, status: "RETUR", returnCaseId: { not: null } } }),
  ]);
  return { fromFile, logged };
}

/** Untuk tombol "Catat retur/komplain" dari daftar pesanan: isi form dari pesanan tertentu */
export async function lookupOrderById(id: string): Promise<OrderHit | null> {
  const o = await prisma.marketplaceOrder.findUnique({ where: { id }, select: { orderNo: true } });
  return o ? (await lookupOrders(o.orderNo, 1))[0] ?? null : null;
}
