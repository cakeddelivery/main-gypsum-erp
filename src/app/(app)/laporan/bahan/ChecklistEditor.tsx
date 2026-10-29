"use client";
import { useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { useCloseModal } from "@/components/Modal";
import type { ChecklistTask } from "@/lib/shiftReport";
import { saveChecklist } from "./actions";

/** Ubah checklist penutupan shift divisi: tambah, hapus, urutkan, tandai wajib foto */
export function ChecklistEditor({ divisionId, initial }: { divisionId: string; initial: ChecklistTask[] }) {
  const close = useCloseModal();
  const [rows, setRows] = useState<ChecklistTask[]>(initial.length ? initial : [{ label: "", photo: true }]);
  const set = (i: number, patch: Partial<ChecklistTask>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) => setRows((r) => {
    const j = i + d;
    if (j < 0 || j >= r.length) return r;
    const c = [...r];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  });
  return (
    <ActionForm action={saveChecklist} className="space-y-2" onSuccess={() => setTimeout(close, 700)}>
      <input type="hidden" name="divisionId" value={divisionId} />
      <input type="hidden" name="n" value={rows.length} />
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 sm:flex-nowrap">
          <input name={`label_${i}`} value={r.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Tugas, mis. Lantai sudah dipel" className="input min-w-0 flex-1 basis-full py-1.5 sm:basis-auto" />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
            <input type="checkbox" name={`photo_${i}`} checked={r.photo} onChange={(e) => set(i, { photo: e.target.checked })} className="h-4 w-4" /> Wajib foto
          </label>
          <div className="ml-auto flex gap-1">
            <button type="button" aria-label="Naik" className="btn-secondary btn-sm" onClick={() => move(i, -1)}>↑</button>
            <button type="button" aria-label="Turun" className="btn-secondary btn-sm" onClick={() => move(i, 1)}>↓</button>
            <button type="button" aria-label="Hapus" className="btn-secondary btn-sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>✕</button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={() => setRows((r) => [...r, { label: "", photo: false }])}>+ Tugas</button>
        <Submit>Simpan checklist</Submit>
      </div>
    </ActionForm>
  );
}
