"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startNavProgress } from "./NavProgress";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const parts = (d: string) => d.split("-").map(Number) as [number, number, number];
const shift = (d: string, days: number) => {
  const [y, m, dd] = parts(d);
  const t = new Date(Date.UTC(y, m - 1, dd + days));
  return t.toISOString().slice(0, 10);
};

/** "8–14 Nov", "28 Okt – 3 Nov", "13 Nov" */
export function rangeLabel(from: string, to: string) {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  if (from === to) return `${d2} ${MONTHS[m2 - 1]}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m2 - 1]}`;
  return `${d1} ${MONTHS[m1 - 1]}${y1 !== y2 ? ` ${y1}` : ""} – ${d2} ${MONTHS[m2 - 1]}`;
}

type Option = { value: string; label: string };

/**
 * Filter daftar Laporan: SATU pemilih rentang tanggal (pilihan cepat Hari ini / 7 hari / Bulan ini, atau tanggal
 * sendiri) + Status (+ Divisi untuk pengelola). Langsung berlaku tanpa tombol Terapkan.
 */
export function ReportFilters({ from, to, today, status, statuses, division, divisions }: { from: string; to: string; today: string; status: string; statuses: Option[]; division?: string; divisions?: Option[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setA(from);
    setB(to);
  }, [from, to]);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", out, true);
    return () => document.removeEventListener("pointerdown", out, true);
  }, [open]);

  const go = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) v ? q.set(k, v) : q.delete(k);
    startNavProgress();
    router.replace(`${path}?${q.toString()}`, { scroll: false });
  };
  const setRange = (f: string, t: string) => {
    setOpen(false);
    go({ dari: f, sampai: t });
  };
  const monthStart = `${today.slice(0, 8)}01`;
  const quick: [string, string, string][] = [
    ["Hari ini", today, today],
    ["7 hari", shift(today, -6), today],
    ["Bulan ini", monthStart, today],
  ];
  const active = quick.find(([, f, t]) => f === from && t === to)?.[0];

  return (
    <div className={`no-print mb-4 grid ${divisions ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2"} items-end gap-2 rounded-xl border border-slate-200 bg-white p-3`}>
      <div ref={box} className="relative">
        <span className="label">Tanggal</span>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((x) => !x)} className="input flex items-center justify-between gap-2 text-left">
          <span className="truncate">{rangeLabel(from, to)}</span>
          <span className="shrink-0 text-xs text-slate-500" aria-hidden>▾</span>
        </button>
        {open && (
          <div role="dialog" aria-label="Pilih rentang tanggal" className="anim-pop absolute left-0 top-full z-40 mt-1 w-[min(18rem,calc(100vw-2.5rem))] rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            <div className="grid grid-cols-3 gap-1.5">
              {quick.map(([l, f, t]) => (
                <button key={l} type="button" onClick={() => setRange(f, t)} className={`min-h-9 rounded-lg px-2 text-xs font-medium ${active === l ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>{l}</button>
              ))}
            </div>
            <div className="keep-cols mt-3 grid grid-cols-2 gap-2">
              <label className="block"><span className="label">Dari</span><input type="date" value={a} max={b} onChange={(e) => setA(e.target.value)} className="input px-2 text-sm" /></label>
              <label className="block"><span className="label">Sampai</span><input type="date" value={b} min={a} max={today} onChange={(e) => setB(e.target.value)} className="input px-2 text-sm" /></label>
            </div>
            <button type="button" className="btn-primary mt-3 w-full" disabled={!a || !b || a > b} onClick={() => setRange(a, b)}>Pakai {a && b && a <= b ? rangeLabel(a, b) : ""}</button>
          </div>
        )}
      </div>
      <label className="block">
        <span className="label">Status</span>
        <select value={status} onChange={(e) => go({ status: e.target.value || null })} className="input">
          {statuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {divisions && (
        <label className="col-span-2 block sm:col-span-1">
          <span className="label">Divisi</span>
          <select value={division ?? ""} onChange={(e) => go({ divisi: e.target.value || null })} className="input">
            {divisions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
