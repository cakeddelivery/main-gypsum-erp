"use client";
import { useState } from "react";
import type { Clause } from "@/lib/contractTemplate";

/** Editor template pasal: judul + isi per pasal (tambah/hapus/urut). Penanda {nama} {masa} {mulai} {selesai} {jadwal} {toleransi} {siklus} {resign_hari} {bpjs_mulai} diisi otomatis. */
export function ClauseEditor({ initial }: { initial: Clause[] }) {
  const [rows, setRows] = useState(() => initial.map((c, i) => ({ k: i, ...c })));
  const set = (i: number, p: Partial<Clause>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <div className="space-y-3">
      {rows.map((c, i) => (
        <div key={c.k} className="space-y-1.5 rounded-lg border border-slate-200 p-3">
          <div className="flex items-center gap-1.5">
            <input name="clauseTitle" value={c.title} onChange={(e) => set(i, { title: e.target.value })} className="input min-w-0 flex-1 font-semibold" placeholder="Judul pasal" aria-label={`Judul pasal ${i + 1}`} />
            <button type="button" className="btn-secondary btn-sm" onClick={() => move(i, -1)} aria-label="Naikkan">↑</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => move(i, 1)} aria-label="Turunkan">↓</button>
            <button type="button" className="btn-secondary btn-sm text-rose-700" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label="Hapus pasal">✕</button>
          </div>
          <textarea name="clauseBody" value={c.body} onChange={(e) => set(i, { body: e.target.value })} className="input" rows={Math.min(10, Math.max(3, c.body.split("\n").length + 1))} aria-label={`Isi pasal ${i + 1}`} />
        </div>
      ))}
      <button type="button" className="btn-secondary w-full" onClick={() => setRows((r) => [...r, { k: Date.now(), title: `Pasal ${r.length + 1} · `, body: "" }])}>+ Tambah pasal</button>
      <p className="text-xs text-slate-500">Baris berawalan &quot;1. &quot; menjadi daftar bernomor. <code>{"{{tabel_upah}}"}</code> menampilkan tabel gaji, tunjangan, dan BPJS. Penanda: {"{nama} {masa} {mulai} {selesai} {jadwal} {toleransi} {siklus} {resign_hari} {bpjs_mulai}"}. Perubahan template hanya berlaku untuk kontrak yang dibuat setelahnya.</p>
    </div>
  );
}
