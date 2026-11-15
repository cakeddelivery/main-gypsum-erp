"use client";
import { useState } from "react";

type Row = { key: number; id?: string; name: string; amount: string; payDay: string; active: boolean };

/**
 * Daftar tunjangan karyawan di form Karyawan. Tiap tunjangan punya nominal, TANGGAL BAYAR tiap bulan (1–31; bulan yang
 * lebih pendek dibayar di akhir bulan) dan status aktif. Dibayar terpisah lewat slip tunjangan pada tanggal itu.
 */
export function AllowanceFields({ initial, defaultPayDay = 15 }: { initial: { id: string; name: string; amount: number; payDay: number; active: boolean }[]; defaultPayDay?: number }) {
  const [rows, setRows] = useState<Row[]>(initial.map((a, i) => ({ key: i, id: a.id, name: a.name, amount: String(a.amount), payDay: String(a.payDay), active: a.active })));
  const [seq, setSeq] = useState(initial.length);
  const set = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <div className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <input type="hidden" name="allowancesPresent" value="1" />
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Tunjangan per bulan <span className="text-xs font-normal text-slate-500">(dibayar terpisah, slip tunjangan)</span></p>
        <button type="button" className="btn-secondary btn-sm" onClick={() => { setRows((r) => [...r, { key: seq, name: "", amount: "", payDay: String(defaultPayDay), active: true }]); setSeq(seq + 1); }}>+ Tunjangan</button>
      </div>
      {rows.length === 0 && <p className="text-xs text-slate-500">Tidak ada tunjangan.</p>}
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className={`space-y-2 rounded-lg border border-slate-200 p-2 ${r.active ? "" : "opacity-60"}`}>
            <input type="hidden" name="allowId" value={r.id ?? ""} />
            <input type="hidden" name="allowActive" value={r.active ? "1" : "0"} />
            <div className="flex gap-2">
              <input name="allowName" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} className="input min-w-0 flex-1" placeholder="cth: Tunjangan makan" aria-label="Nama tunjangan" required />
              <button type="button" className="btn-secondary btn-sm shrink-0" aria-label="Hapus tunjangan" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>✕</button>
            </div>
            <div className="keep-cols grid grid-cols-2 gap-2">
              <label className="block min-w-0"><span className="text-xs text-slate-500">Nominal (Rp)</span>
                <input name="allowAmount" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} inputMode="numeric" className="input" placeholder="Rp" required />
              </label>
              <label className="block min-w-0"><span className="text-xs text-slate-500">Tanggal bayar (1–31)</span>
                <input name="allowPayDay" value={r.payDay} onChange={(e) => set(r.key, { payDay: e.target.value })} inputMode="numeric" className="input" min={1} max={31} required />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.active} onChange={(e) => set(r.key, { active: e.target.checked })} className="h-4 w-4" /> Aktif (dibayar tiap bulan)</label>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Tanggal 29–31 dibayar di akhir bulan pada bulan yang lebih pendek (mis. Februari).</p>
    </div>
  );
}
