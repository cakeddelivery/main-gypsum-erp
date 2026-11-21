import { prisma } from "../db";
import { addDays, todayStr } from "../time";
import { syncConfig } from "./sync";
import type { FileKind } from "./parse";

/**
 * Kelengkapan data per bulan: baris = toko × kanal, kolom = bulan, sel = status tiap jenis file wajib.
 * Cakupan dibaca dari PERIODE ISI file yang sudah diimpor (bukan nama file). Hanya penilaian (tidak mengubah data).
 */
export const REQUIRED: Record<string, FileKind[]> = { SHP: ["ORDER", "INCOME", "BALANCE", "ADSBILL"], TTS: ["ORDER", "INCOME"] };
export const KIND_LABEL: Record<string, string> = { ORDER: "Pesanan", INCOME: "Penghasilan", BALANCE: "Saldo Penjual", ADSBILL: "Saldo Iklan" };
export const CH_LABEL: Record<string, string> = { SHP: "Shopee", TTS: "TikTok" };

export type CellStatus = "OK" | "PARTIAL" | "MISSING" | "WAIT" | "NA";
export type Cell = { status: CellStatus; /** tanggal terakhir yang tercakup (YYYY-MM-DD) */ through: string | null; note?: string };
export type Interval = [string, string];

/** Gabungkan rentang tanggal yang bersambung / berjarak ≤ gap hari */
export function mergeIntervals(list: Interval[], gap = 3): Interval[] {
  const xs = [...list].sort((a, b) => a[0].localeCompare(b[0]));
  const out: Interval[] = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= addDays(last[1], gap + 1)) { if (e > last[1]) last[1] = e; } else out.push([s, e]);
  }
  return out;
}

/**
 * Status satu sel. OK bila satu rentang gabungan menutup [reqStart, reqEnd] dengan toleransi (jeda libur/pelepasan dana);
 * PARTIAL bila ada irisan; MISSING bila tidak ada. through = tanggal terakhir yang tercakup di bulan itu.
 */
export function coverCell(intervals: Interval[], reqStart: string, reqEnd: string, tol = 3): Cell {
  if (reqEnd < reqStart) return { status: "NA", through: null };
  const merged = mergeIntervals(intervals);
  const hit = merged.filter(([s, e]) => s <= reqEnd && e >= reqStart);
  if (!hit.length) return { status: "MISSING", through: null };
  const through = hit.reduce((m, [, e]) => (e > m ? e : m), "0000-00-00");
  const clipped = through > reqEnd ? reqEnd : through;
  const whole = hit.some(([s, e]) => s <= addDays(reqStart, tol) && e >= addDays(reqEnd, -tol));
  return { status: whole ? "OK" : "PARTIAL", through: clipped };
}

const monthOf = (d: string) => d.slice(0, 7);
const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`; };
export const nextMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
export const monthsBetween = (from: string, to: string) => { const out: string[] = []; for (let m = from; m <= to && out.length < 36; m = nextMonth(m)) out.push(m); return out; };

export type Gap = { storeId: string; channel: string; kind: string; note: string | null; reviewAt: string; paused: boolean; due: boolean };

export async function accessGaps(today = todayStr()): Promise<Gap[]> {
  const rows = await prisma.marketplaceAccessGap.findMany();
  return rows.map((g) => { const reviewAt = g.reviewAt.toISOString().slice(0, 10); return { storeId: g.storeId, channel: g.channel, kind: g.kind, note: g.note, reviewAt, paused: today < reviewAt, due: today >= reviewAt }; });
}

export type MatrixRow = { storeId: string; store: string; channel: string; cells: Record<string, Record<string, Cell>> };
export type Matrix = { active: boolean; start: string | null; through: string; months: string[]; rows: MatrixRow[]; missing: { store: string; storeId: string; channel: string; kind: string; month: string; status: CellStatus; through: string | null }[]; gaps: Gap[] };

/** Matriks kelengkapan. Bulan wajib = sejak tanggal mulai (pengaturan sinkron) sampai KEMARIN; tanpa tanggal mulai: dari data pertama (hanya informasi). */
export async function completeness(now = new Date()): Promise<Matrix> {
  const cfg = await syncConfig();
  const through = addDays(todayStr(now), -1);
  const [stores, imports, gaps] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true }, orderBy: { code: "asc" } }),
    prisma.marketplaceImport.findMany({ where: { undoneAt: null, periodFrom: { not: null } }, select: { storeId: true, channel: true, kind: true, periodFrom: true, periodTo: true } }),
    accessGaps(todayStr(now)),
  ]);
  const iv = new Map<string, Interval[]>();
  let first: string | null = null;
  for (const i of imports) {
    const s = i.periodFrom!.toISOString().slice(0, 10), e = (i.periodTo ?? i.periodFrom)!.toISOString().slice(0, 10);
    const k = `${i.storeId}|${i.channel}|${i.kind}`;
    iv.set(k, [...(iv.get(k) ?? []), [s, e]]);
    if (!first || s < first) first = s;
  }
  const start = cfg.start;
  const base = start ?? first;
  const active = !!start && through >= start;
  const empty: Matrix = { active, start, through, months: [], rows: [], missing: [], gaps };
  if (!base || through < base) return empty;
  const months = monthsBetween(monthOf(base), monthOf(through));
  const gapOf = new Map(gaps.map((g) => [`${g.storeId}|${g.channel}|${g.kind}`, g]));
  const rows: MatrixRow[] = [];
  const missing: Matrix["missing"] = [];
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      // toko/kanal yang belum pernah dipakai (tanpa file & tanpa catatan akses) tidak ditagih
      const used = REQUIRED[ch].some((k) => iv.has(`${s.id}|${ch}|${k}`) || gapOf.has(`${s.id}|${ch}|${k}`));
      if (!used) continue;
      const cells: MatrixRow["cells"] = {};
      for (const m of months) {
        cells[m] = {};
        const reqStart = base > monthStart(m) ? base : monthStart(m);
        const reqEnd = monthEnd(m) < through ? monthEnd(m) : through;
        const current = monthOf(through) === m;
        for (const kind of REQUIRED[ch]) {
          const c = coverCell(iv.get(`${s.id}|${ch}|${kind}`) ?? [], reqStart, reqEnd, current ? 2 : 3);
          const g = gapOf.get(`${s.id}|${ch}|${kind}`);
          if (c.status !== "OK" && c.status !== "NA" && g?.paused) c.status = "WAIT", c.note = g.note ?? "menunggu akses";
          cells[m][kind] = c;
          if (c.status === "MISSING" || c.status === "PARTIAL") missing.push({ store: s.name, storeId: s.id, channel: ch, kind, month: m, status: c.status, through: c.through });
        }
      }
      rows.push({ storeId: s.id, store: s.name, channel: ch, cells });
    }
  }
  return { active, start, through, months, rows, missing, gaps };
}

/** Toko × kanal yang Penghasilannya ditandai "akses belum tersedia" (Piutang tidak bisa divalidasi) */
export async function incomeGapStores(today = todayStr()) {
  return (await accessGaps(today)).filter((g) => g.kind === "INCOME");
}

/** Teks ringkas untuk pengingat: "Shopee Dunia Lukis Penghasilan Okt, Nov" dst. */
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const bulanLabel = (m: string) => `${BULAN[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
export function missingLines(missing: Matrix["missing"]) {
  const g = new Map<string, string[]>();
  for (const x of missing) {
    const k = `${CH_LABEL[x.channel]} ${x.store} ${KIND_LABEL[x.kind]}`;
    g.set(k, [...(g.get(k) ?? []), `${bulanLabel(x.month)}${x.status === "PARTIAL" ? " (sebagian)" : ""}`]);
  }
  return [...g.entries()].map(([k, ms]) => `${k}: ${ms.join(", ")}`);
}

/** Pesanan lebih dari 14 hari tanpa data penghasilan, hanya untuk toko×kanal yang aksesnya tersedia */
export async function ordersWithoutIncome(now = new Date(), days = 14) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const gaps = (await accessGaps(todayStr(now))).filter((g) => g.kind === "INCOME" && g.paused);
  const skip = new Set(gaps.map((g) => `${g.storeId}|${g.channel}`));
  const rows = await prisma.marketplaceOrder.groupBy({ by: ["storeId", "channel"], where: { incomeId: null, status: { not: "BATAL" }, needsCheck: null, orderedAt: { lt: cutoff } }, _count: true });
  return rows.filter((r) => !skip.has(`${r.storeId}|${r.channel}`)).map((r) => ({ storeId: r.storeId, channel: r.channel, count: r._count }));
}
