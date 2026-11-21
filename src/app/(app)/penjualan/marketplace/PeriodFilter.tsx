import Link from "next/link";
import { QUICK, resolvePeriod, type Period } from "@/lib/marketplace/periode";

type SP = Record<string, string | undefined>;
const PERIOD_KEYS = ["periode", "bulan", "dari", "sampai"];

/** Alamat dengan filter lain (toko, kanal, tab…) dipertahankan; hanya parameter periode yang diganti */
export function hrefWith(sp: SP, patch: SP, path = "") {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && !PERIOD_KEYS.includes(k)) q.set(k, v);
  for (const [k, v] of Object.entries(patch)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
}

/**
 * Filter periode seragam untuk halaman marketplace: Hari ini · Kemarin · 7 hari terakhir · Minggu ini · Bulan ini · Bulan lalu ·
 * 3 bulan terakhir · Tahun ini · Pilih bulan · Rentang tanggal. Disimpan di URL (?periode=…) sehingga bisa dibagikan. Bawaan: Bulan ini.
 * `monthly`: hanya pilihan yang berupa satu bulan penuh (laporan bulanan: Pengeluaran, Cek integritas).
 */
export function PeriodFilter({ sp, period, monthly = false, allTime = false, compare = false }: { sp: SP; period: Period; monthly?: boolean; compare?: boolean; /** halaman ini tidak membatasi tanggal (semua waktu) sampai periode dipilih */ allTime?: boolean }) {
  const quick = monthly ? QUICK.filter(([k]) => k === "bulan-ini" || k === "bulan-lalu") : QUICK;
  const hidden = Object.entries(sp).filter(([k, v]) => v && !PERIOD_KEYS.includes(k)) as [string, string][];
  const active = (k: string) => !allTime && period.key === k;
  return (
    <div className="no-print mb-3 space-y-2" role="group" aria-label="Periode">
      <div className="flex flex-wrap gap-1.5">
        {quick.map(([k, label]) => (
          <Link key={k} href={hrefWith(sp, { periode: k })} aria-current={active(k) ? "true" : undefined} className={`btn-sm ${active(k) ? "btn-primary" : "btn-secondary"}`}>{label}</Link>
        ))}
        <details className="relative">
          <summary className={`btn-sm cursor-pointer list-none ${period.key === "bulan" || period.key === "rentang" ? "btn-primary" : "btn-secondary"}`}>{period.key === "bulan" || period.key === "rentang" ? period.label : monthly ? "Pilih bulan" : "Pilih bulan / rentang"}</summary>
          <div className="absolute left-0 z-30 mt-1 w-72 space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            <form method="get" className="flex items-end gap-2">
              {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <label className="flex-1 text-xs text-slate-500">Bulan<input type="month" name="bulan" defaultValue={period.from.slice(0, 7)} className="input" required /></label>
              <button className="btn-secondary btn-sm" type="submit">Terapkan</button>
            </form>
            {!monthly && (
              <form method="get" className="grid grid-cols-2 items-end gap-2">
                {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                <label className="text-xs text-slate-500">Dari<input type="date" name="dari" defaultValue={period.from} className="input" required /></label>
                <label className="text-xs text-slate-500">Sampai<input type="date" name="sampai" defaultValue={period.to} className="input" required /></label>
                <button className="btn-secondary btn-sm col-span-2" type="submit">Terapkan rentang</button>
              </form>
            )}
          </div>
        </details>
      </div>
      <p className="text-xs text-slate-500">{allTime ? <>Periode: <b>Semua waktu</b> (pilih periode untuk membatasi)</> : <>Periode: <b>{period.label}</b> ({period.from} s/d {period.to}, {period.days} hari){compare && !monthly ? <> · dibandingkan dengan {period.prevFrom} s/d {period.prevTo}</> : null}</>}</p>
    </div>
  );
}

export { resolvePeriod };
