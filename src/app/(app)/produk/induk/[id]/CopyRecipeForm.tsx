"use client";
import { useState } from "react";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { copyFamilyRecipe } from "../actions";

type Sku = { id: string; label: string; hasRecipe: boolean; group: string };

/** Salin resep: pilih SKU sumber (yang sudah punya resep), centang SKU tujuan; tombol cepat per kelompok */
export function CopyRecipeForm({ skus }: { skus: Sku[] }) {
  const sources = skus.filter((s) => s.hasRecipe);
  const [from, setFrom] = useState(sources[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (ids: string[], on: boolean) => setPicked((cur) => { const n = new Set(cur); for (const id of ids) if (id !== from) (on ? n.add(id) : n.delete(id)); return n; });
  const groups = [...new Set(skus.map((s) => s.group))];
  if (!sources.length) return <p className="text-sm text-slate-500">Belum ada SKU yang punya resep. Isi resep satu SKU dulu (buka Detail SKU → Resep HPP), lalu salin dari sini.</p>;
  return (
    <ModalForm action={copyFamilyRecipe} className="space-y-3">
      <label className="block">
        <span className="label">Salin resep dari</span>
        <select name="fromId" value={from} onChange={(e) => setFrom(e.target.value)} className="input">
          {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn-secondary btn-sm" onClick={() => toggle(skus.filter((s) => !s.hasRecipe).map((s) => s.id), true)}>Pilih yang belum ada resep</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => toggle(skus.map((s) => s.id), true)}>Pilih semua</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setPicked(new Set())}>Kosongkan</button>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {groups.map((g) => {
          const list = skus.filter((s) => s.group === g);
          return (
            <div key={g}>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-600">
                {g || "SKU"}
                <button type="button" className="text-brand-600 underline" onClick={() => toggle(list.map((s) => s.id), !list.every((s) => picked.has(s.id) || s.id === from))}>pilih/lepas grup</button>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {list.map((s) => (
                  <label key={s.id} className={`flex items-center gap-2 text-sm ${s.id === from ? "opacity-40" : ""}`}>
                    <input type="checkbox" name="target" value={s.id} disabled={s.id === from} checked={picked.has(s.id) && s.id !== from} onChange={(e) => toggle([s.id], e.target.checked)} />
                    <span>{s.label}{s.hasRecipe && <span className="text-xs text-amber-600"> (resep lama diganti)</span>}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">Yang disalin: bahan & kemasan, tenaga kerja, overhead, tambahan kemasan, target margin. Setelah disalin, resep tiap SKU tetap bisa diubah sendiri.</p>
      <Submit>Salin ke {picked.size} SKU</Submit>
    </ModalForm>
  );
}
