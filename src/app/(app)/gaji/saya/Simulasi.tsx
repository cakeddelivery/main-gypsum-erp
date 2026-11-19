"use client";
import { useState } from "react";
import { projectSalary, type ProjectionInput } from "@/lib/salaryProjection";
import { idr } from "@/lib/money";

/** Simulasi bolos: pilih jumlah hari Alpa tambahan → potongan & perkiraan diterima berubah */
export function Simulasi({ input, max = 6 }: { input: ProjectionInput; max?: number }) {
  const [a, setA] = useState(0);
  const p = projectSalary(input, a);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Jumlah hari Alpa tambahan">
        {Array.from({ length: max + 1 }, (_, i) => (
          <button key={i} type="button" aria-pressed={a === i} onClick={() => setA(i)} className={`rounded-lg border px-3 py-1 text-sm ${a === i ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 bg-white text-slate-700"}`}>{i === 0 ? "0 hari" : i}</button>
        ))}
      </div>
      <div className="flex justify-between text-sm"><span>Potongan Alpa ({p.alpaDays} hari)</span><b className="tabular-nums text-rose-700">{p.cut ? `− ${idr(p.cut)}` : idr(0)}</b></div>
      <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold"><span>Perkiraan diterima</span><span className="tabular-nums">{idr(p.total)}</span></div>
      <p className="text-xs text-slate-500">Rumus: gaji pokok ÷ 30 × hari Alpa (Rp {p.perDay.toLocaleString("id-ID")} per hari). Izin dan sakit yang disetujui tidak dipotong.</p>
    </div>
  );
}
