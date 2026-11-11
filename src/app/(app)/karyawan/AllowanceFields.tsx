"use client";
import { useState } from "react";

type Row = { key: number; id?: string; name: string; amount: string };

/** Daftar tunjangan karyawan di form Karyawan (dibayar terpisah tiap tanggal tunjangan, mis. tgl 15) */
export function AllowanceFields({ initial }: { initial: { id: string; name: string; amount: number }[] }) {
  const [rows, setRows] = useState<Row[]>(initial.map((a, i) => ({ key: i, id: a.id, name: a.name, amount: String(a.amount) })));
  const [seq, setSeq] = useState(initial.length);
  const set = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <div className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <input type="hidden" name="allowancesPresent" value="1" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Tunjangan per bulan <span className="text-xs font-normal text-slate-500">(dibayar terpisah, slip tunjangan)</span></p>
        <button type="button" className="btn-secondary btn-sm" onClick={() => { setRows((r) => [...r, { key: seq, name: "", amount: "" }]); setSeq(seq + 1); }}>+ Tunjangan</button>
      </div>
      {rows.length === 0 && <p className="text-xs text-slate-500">Tidak ada tunjangan.</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="flex gap-2">
            <input type="hidden" name="allowId" value={r.id ?? ""} />
            <input name="allowName" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} className="input min-w-0 flex-1" placeholder="cth: Tunjangan makan" required />
            <input name="allowAmount" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} inputMode="numeric" className="input w-32" placeholder="Rp" required />
            <button type="button" className="btn-secondary btn-sm shrink-0" aria-label="Hapus tunjangan" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
