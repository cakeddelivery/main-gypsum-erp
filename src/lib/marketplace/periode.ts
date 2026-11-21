import { addDays, todayStr } from "../time";

/**
 * Periode laporan marketplace yang seragam: pilihan cepat + bulan + rentang. Disimpan di URL (?periode=…; bulan: ?bulan=YYYY-MM;
 * rentang: ?dari=&sampai=). Murni (tanpa database) agar mudah dites. Perbandingan = periode sebelumnya yang SAMA PANJANG.
 */
export const QUICK = [
  ["hari-ini", "Hari ini"], ["kemarin", "Kemarin"], ["7-hari", "7 hari terakhir"], ["minggu-ini", "Minggu ini"], ["bulan-ini", "Bulan ini"],
  ["bulan-lalu", "Bulan lalu"], ["3-bulan", "3 bulan terakhir"], ["tahun-ini", "Tahun ini"],
] as const;
export type PeriodKey = (typeof QUICK)[number][0] | "bulan" | "rentang";
export const DEFAULT_PERIOD: PeriodKey = "bulan-ini";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`; };
const prevMonthKey = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };
/** Senin pekan itu (YYYY-MM-DD) */
const mondayOf = (d: string) => { const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((dow + 6) % 7)); };

export type Period = { key: PeriodKey; label: string; from: string; to: string; days: number; prevFrom: string; prevTo: string; /** grafik per minggu bila > 92 hari */ weekly: boolean };

export type PeriodParams = { periode?: string; bulan?: string; dari?: string; sampai?: string };

export function resolvePeriod(sp: PeriodParams, today = todayStr()): Period {
  const month = today.slice(0, 7);
  let key: PeriodKey = DEFAULT_PERIOD;
  let from = `${month}-01`, to = today, label = "Bulan ini";
  const quick = QUICK.find(([k]) => k === sp.periode);
  if (quick) {
    key = quick[0]; label = quick[1];
    switch (key) {
      case "hari-ini": from = today; break;
      case "kemarin": from = to = addDays(today, -1); break;
      case "7-hari": from = addDays(today, -6); break;
      case "minggu-ini": from = mondayOf(today); break;
      case "bulan-ini": from = `${month}-01`; break;
      case "bulan-lalu": { const pm = prevMonthKey(month); from = `${pm}-01`; to = monthEnd(pm); break; }
      case "3-bulan": from = `${prevMonthKey(prevMonthKey(month))}-01`; break;
      case "tahun-ini": from = `${today.slice(0, 4)}-01-01`; break;
    }
  } else if (MONTH.test(sp.bulan ?? "") && !sp.dari) {
    key = "bulan"; from = `${sp.bulan}-01`; to = monthEnd(sp.bulan!); label = `Bulan ${sp.bulan}`;
  } else if (DATE.test(sp.dari ?? "") || DATE.test(sp.sampai ?? "")) {
    key = "rentang";
    from = DATE.test(sp.dari ?? "") ? sp.dari! : `${month}-01`;
    to = DATE.test(sp.sampai ?? "") ? sp.sampai! : today;
    if (to < from) [from, to] = [to, from];
    label = `${from} s/d ${to}`;
  }
  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { key, label, from, to, days, prevFrom: addDays(prevTo, -(days - 1)), prevTo, weekly: days > 92 };
}

/** Selisih % terhadap periode sebelumnya (null bila pembanding nol) */
export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

/** Semua tanggal dari..sampai, dikelompokkan per hari atau per minggu (Senin) bila weekly */
export function buckets(from: string, to: string, weekly: boolean): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) {
    const k = weekly ? mondayOf(d) : d;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, label: weekly ? `${k.slice(8)}/${k.slice(5, 7)}` : (from.slice(0, 7) === to.slice(0, 7) ? d.slice(8) : `${d.slice(8)}/${d.slice(5, 7)}`) });
  }
  return out;
}
export const bucketKey = (d: string, weekly: boolean) => (weekly ? mondayOf(d) : d);
