import type { Trend } from "@/lib/unitcost";

/** Indikator harga/HPP: naik = merah, turun = hijau, tetap = abu-abu */
export function TrendBadge({ t, title }: { t: Trend; title?: string }) {
  if (t.dir === "TETAP") return <span className="whitespace-nowrap text-xs text-slate-400" title={title ?? "Tetap dibanding pembelian sebelumnya"}>= tetap</span>;
  const up = t.dir === "NAIK";
  return (
    <span className={`whitespace-nowrap text-xs font-medium ${up ? "text-rose-600" : "text-emerald-600"}`} title={title ?? `${up ? "Naik" : "Turun"} dibanding pembelian sebelumnya`}>
      {up ? "▲" : "▼"} {t.pct ? `${up ? "+" : ""}${t.pct.toLocaleString("id-ID")}%` : `${up ? "+" : ""}${t.diff.toLocaleString("id-ID")}`}
    </span>
  );
}
