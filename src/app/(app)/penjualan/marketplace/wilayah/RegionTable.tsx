"use client";
import { useMemo, useState } from "react";

type Row = { name: string; province?: string; orders: number; retur: number; rusak: number; pct: number; high: boolean };
type Key = "name" | "province" | "orders" | "retur" | "rusak" | "pct";

/** Tabel wilayah yang bisa diurutkan: klik judul kolom (naik/turun) */
export function RegionTable({ rows, first, size = 15 }: { rows: Row[]; first: string; size?: number }) {
  const [key, setKey] = useState<Key>("orders");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const m = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[key] ?? "", y = b[key] ?? "";
      return (typeof x === "string" ? x.localeCompare(String(y), "id") : (x as number) - (y as number)) * m || a.name.localeCompare(b.name, "id");
    });
  }, [rows, key, dir]);
  const th = (k: Key, label: string, num = false) => (
    <th className={num ? "num" : ""}>
      <button type="button" onClick={() => (k === key ? setDir(dir === "asc" ? "desc" : "asc") : (setKey(k), setDir(k === "name" || k === "province" ? "asc" : "desc")))} className="inline-flex items-center gap-1 whitespace-nowrap font-semibold hover:text-brand-700" aria-label={`Urutkan ${label}`}>
        {label}
        <span aria-hidden className={k === key ? "text-brand-600" : "text-slate-300"}>{k === key ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
  const shown = all ? sorted : sorted.slice(0, size);
  const hasProv = rows[0]?.province !== undefined;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{th("name", first)}{hasProv && th("province", "Provinsi")}{th("orders", "Pesanan", true)}{th("retur", "Retur", true)}{th("rusak", "Rusak", true)}{th("pct", "% retur", true)}<th></th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.name + (r.province ?? "")}>
              <td>{r.name}</td>{hasProv && <td>{r.province}</td>}
              <td className="num">{r.orders}</td><td className="num">{r.retur}</td><td className="num">{r.rusak}</td>
              <td className="num">{r.pct.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%</td>
              <td>{r.high && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">Tinggi</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > size && <button type="button" className="btn-secondary m-2" onClick={() => setAll(!all)}>{all ? "Ringkas" : `Tampilkan semua (${sorted.length})`}</button>}
    </div>
  );
}
