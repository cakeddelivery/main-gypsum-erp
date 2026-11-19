"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

/** Pilih hari libur minggu depan (Senin–Minggu) dengan kotak centang */
export function DayOffFields({ days }: { days: { date: string; label: string }[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <>
      <p className="text-sm text-slate-600">Centang hari yang ingin diliburkan.</p>
      <div className="grid grid-cols-2 gap-2 keep-cols">
        {days.map((d) => (
          <label key={d.date} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${picked.includes(d.date) ? "border-brand-500 bg-brand-50 font-semibold" : "border-slate-200"}`}>
            <input type="checkbox" name="date" value={d.date} checked={picked.includes(d.date)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, d.date] : p.filter((x) => x !== d.date)))} />
            {d.label}
          </label>
        ))}
      </div>
      <Field label="Alasan (opsional)"><textarea name="reason" className="input" rows={2} placeholder="Mis. acara keluarga" maxLength={300} /></Field>
    </>
  );
}
