import { prisma } from "../db";
import { audit } from "../audit";
import { parseFees } from "../pricing";
import { n } from "../money";
import { potonganReport } from "./potongan";
import { monthBounds } from "./dashboard";
import { CHANNEL_LABEL } from "./rules";

/**
 * Laporan pengeluaran marketplace lengkap: semua uang keluar dari harga jual sampai rekening, per sektor.
 * Hanya baca (kecuali menyimpan target). Tidak membuat jurnal.
 */
export type SectorDef = { key: string; label: string; cats: string[]; info?: boolean };
export const SECTORS: SectorDef[] = [
  { key: "ADMIN", label: "Admin / komisi platform", cats: ["ADMIN"] },
  { key: "PROSES", label: "Biaya proses pesanan", cats: ["PROSES"] },
  { key: "ONGKIR_PROGRAM", label: "Program ongkir (Xtra / logistik)", cats: ["ONGKIR_PROGRAM"] },
  { key: "ONGKIR", label: "Selisih ongkir", cats: ["ONGKIR"] },
  { key: "AFFILIATE", label: "Affiliate (komisi)", cats: ["AFFILIATE"] },
  { key: "AFFILIATE_SAMPEL", label: "Ongkir sampel affiliate", cats: ["AFFILIATE_SAMPEL"] },
  { key: "IKLAN", label: "Iklan (pemakaian aktual)", cats: ["IKLAN"] },
  { key: "PPN_IKLAN", label: "PPN iklan (dari isi saldo iklan)", cats: [] },
  { key: "PESANAN_HILANG", label: "Pesanan hilang (kompensasi mengurangi biaya)", cats: ["PESANAN_HILANG"] },
  { key: "REFUND", label: "Refund / retur", cats: ["REFUND"] },
  { key: "VOUCHER", label: "Voucher penjual", cats: ["VOUCHER"] },
  { key: "ASURANSI", label: "Asuransi (premi)", cats: ["ASURANSI"] },
  { key: "LAYANAN", label: "Layanan Live / video / pre-order", cats: ["LAYANAN"] },
  { key: "PAJAK", label: "Pajak (PPh 22)", cats: ["PAJAK"] },
  { key: "PENYESUAIAN", label: "Penyesuaian lain", cats: ["PENYESUAIAN", "LAINNYA"] },
  { key: "DISKON_PENJUAL", label: "Diskon penjual (info, sudah di harga)", cats: [], info: true },
];

const TARGET_KEY = "marketplace_cost_targets";
export const targetKey = (channel: string, sector: string) => `${channel}:${sector}`;

export async function loadTargets(): Promise<Record<string, number>> {
  try {
    const v = JSON.parse((await prisma.setting.findUnique({ where: { key: TARGET_KEY } }))?.value ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export async function saveTargets(actor: { id: string; name: string }, targets: Record<string, number>) {
  const clean = Object.fromEntries(Object.entries(targets).filter(([, v]) => Number.isFinite(v) && v >= 0 && v <= 100));
  await prisma.setting.upsert({ where: { key: TARGET_KEY }, create: { key: TARGET_KEY, value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
  await audit(actor, "MARKETPLACE_TARGET_BIAYA", "Setting", TARGET_KEY, clean);
}

/** Target bawaan dari pengaturan Produk › Biaya (admin/xtra), rata-rata affiliatePct & adsPct produk */
async function defaultTargets(channel: string): Promise<Record<string, number>> {
  const cfg = parseFees((await prisma.setting.findUnique({ where: { key: "marketplace_fees" } }))?.value)[channel === "SHP" ? "SHOPEE" : "TIKTOK_SHOP"];
  const out: Record<string, number> = {};
  const pct = (name: RegExp) => cfg?.fees.filter((f) => name.test(f.name)).reduce((a, f) => a + (Number(f.pct) || 0), 0);
  if (channel === "SHP") {
    const a = pct(/admin/i), x = pct(/xtra|ongkir/i);
    if (a) out.ADMIN = a;
    if (x) out.ONGKIR_PROGRAM = x;
  } else {
    const a = pct(/komisi/i);
    if (a) out.ADMIN = a;
  }
  const prods = await prisma.product.findMany({ where: { active: true }, select: { affiliatePct: true, adsPct: true } });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const aff = avg(prods.map((p) => Number(p.affiliatePct)).filter((v) => v > 0));
  const ads = avg(prods.map((p) => Number(p.adsPct)).filter((v) => v > 0));
  if (aff) out.AFFILIATE = Math.round(aff * 100) / 100;
  if (ads) out.IKLAN = Math.round(ads * 100) / 100;
  return out;
}

type Month = { gross: number; released: number; values: Record<string, number> };
/** Nilai biaya per sektor (positif = biaya) untuk satu bulan */
async function monthValues(month: string, channel: string, storeId?: string): Promise<Month> {
  const { from, to } = monthBounds(month);
  const r = await potonganReport({ storeId, channel, from, to });
  const values: Record<string, number> = {};
  for (const s of SECTORS) {
    if (s.key === "PPN_IKLAN") values[s.key] = r.adsInfo.ppn;
    else if (s.key === "DISKON_PENJUAL") values[s.key] = Math.abs(Object.entries(r.byColumn).filter(([c]) => /diskon penjual/.test(c)).reduce((a, [, v]) => a + v, 0));
    else values[s.key] = -s.cats.reduce((a, c) => a + (r.byCategory[c] ?? 0), 0);
  }
  // Shopee: voucher penjual hanya biaya bila platformnya mengurangi saldo (sudah diatur di kategori counted); TikTok → info
  if (channel === "TTS") values.VOUCHER = 0;
  return { gross: r.gross, released: r.released, values };
}

const prevMonth = (m: string, k: number) => {
  let [y, mo] = m.split("-").map(Number);
  mo -= k;
  while (mo <= 0) { mo += 12; y--; }
  return `${y}-${String(mo).padStart(2, "0")}`;
};

export type SectorRow = { key: string; label: string; info: boolean; value: number; pct: number; prevValue: number; prevPct: number; delta: number; target: number | null; targetSource: "ATUR" | "PENGATURAN" | "RATA3" | null; over: boolean };

export async function pengeluaranReport(f: { month: string; storeId?: string; channel: string }) {
  const [cur, prev, h2, h3, custom, defaults] = await Promise.all([
    monthValues(f.month, f.channel, f.storeId),
    monthValues(prevMonth(f.month, 1), f.channel, f.storeId),
    monthValues(prevMonth(f.month, 2), f.channel, f.storeId),
    monthValues(prevMonth(f.month, 3), f.channel, f.storeId),
    loadTargets(),
    defaultTargets(f.channel),
  ]);
  const pctOf = (m: Month, v: number) => (m.gross ? (v / m.gross) * 100 : 0);
  const history = [prev, h2, h3].filter((m) => m.gross > 0);
  const rows: SectorRow[] = SECTORS.map((s) => {
    const value = cur.values[s.key] ?? 0;
    const pct = pctOf(cur, value);
    const prevPct = pctOf(prev, prev.values[s.key] ?? 0);
    let target: number | null = null;
    let targetSource: SectorRow["targetSource"] = null;
    const c = custom[targetKey(f.channel, s.key)];
    if (c !== undefined) { target = c; targetSource = "ATUR"; }
    else if (defaults[s.key] !== undefined) { target = defaults[s.key]; targetSource = "PENGATURAN"; }
    else if (history.length) {
      const avg = history.reduce((a, m) => a + pctOf(m, m.values[s.key] ?? 0), 0) / history.length;
      if (avg > 0) { target = Math.round(avg * 1.2 * 100) / 100; targetSource = "RATA3"; }
    }
    return { key: s.key, label: s.label, info: !!s.info, value, pct, prevValue: prev.values[s.key] ?? 0, prevPct, delta: pct - prevPct, target, targetSource, over: !s.info && target !== null && value > 0 && pct > target + 0.05 };
  });
  const costRows = rows.filter((r) => !r.info);
  const total = costRows.reduce((a, r) => a + r.value, 0);
  const prevTotal = costRows.reduce((a, r) => a + r.prevValue, 0);
  return { month: f.month, channel: f.channel, label: CHANNEL_LABEL[f.channel], gross: cur.gross, released: cur.released, rows, total, totalPct: cur.gross ? (total / cur.gross) * 100 : 0, prevTotal, prevTotalPct: prev.gross ? (prevTotal / prev.gross) * 100 : 0, overs: rows.filter((r) => r.over).map((r) => r.key) };
}

/** Pesanan yang tampak HILANG (status/alasan memuat "hilang") dan belum ada kompensasinya di penyesuaian */
export async function lostOrdersWithoutCompensation(f: { month: string; storeId?: string; channel: string }) {
  const { from, to } = monthBounds(f.month);
  const lost = await prisma.marketplaceOrder.findMany({
    where: { channel: f.channel, ...(f.storeId ? { storeId: f.storeId } : {}), orderedAt: { gte: new Date(`${from}T00:00:00+07:00`), lt: new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86400000) }, OR: [{ rawStatus: { contains: "hilang", mode: "insensitive" } }, { cancelReason: { contains: "hilang", mode: "insensitive" } }, { rawReturn: { contains: "hilang", mode: "insensitive" } }, { rawStatus: { contains: "lost", mode: "insensitive" } }] },
    select: { orderNo: true, total: true },
  });
  if (!lost.length) return { count: 0, value: 0, orders: [] as string[] };
  const comp = await prisma.marketplaceIncome.findMany({ where: { channel: f.channel, kind: "ADJUST", refNo: { in: lost.map((l) => l.orderNo) }, released: { gt: 0 } }, select: { refNo: true } });
  const got = new Set(comp.map((c) => c.refNo));
  const left = lost.filter((l) => !got.has(l.orderNo));
  return { count: left.length, value: left.reduce((a, l) => a + n(l.total), 0), orders: left.slice(0, 10).map((l) => l.orderNo) };
}
