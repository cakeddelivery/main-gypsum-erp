"use client";
import { useActionState, useEffect } from "react";
import { toast } from "@/components/Toaster";
import { setItemsDivision } from "../actions";

/** Bar ubah divisi massal: kotak centang baris tabel memakai atribut form={formId} */
export function BulkDivision({ formId, divisions }: { formId: string; divisions: { id: string; name: string }[] }) {
  const [state, run, pending] = useActionState(setItemsDivision, null);
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast(state.message ?? "Tersimpan");
    else toast(state.error ?? "Gagal", false);
  }, [state]);
  const all = (on: boolean) => document.querySelectorAll<HTMLInputElement>(`input[type=checkbox][form="${formId}"]`).forEach((c) => (c.checked = on));
  return (
    <form id={formId} action={run} className="flex flex-wrap items-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2 text-sm">
      <span className="text-slate-600">Ubah massal:</span>
      <button type="button" className="btn-secondary btn-sm" onClick={() => all(true)}>Centang semua</button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => all(false)}>Hapus centang</button>
      <select name="divisionId" className="input w-auto py-1.5" defaultValue="" aria-label="Divisi penanggung jawab">
        <option value="">— tanpa divisi —</option>
        {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button type="submit" className="btn-primary btn-sm" disabled={pending}>{pending ? "Menyimpan…" : "Set divisi yang dicentang"}</button>
    </form>
  );
}
