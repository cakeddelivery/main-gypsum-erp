"use client";
import { useRef, useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { mapSkuAction } from "../actions";

const VARIANTS = ["Bubble Wrap", "Extra Dus", "Extra Dus + Bubble Wrap"];

/** Satu baris rapi: [Produk jadi | Extra Packing] [pilihan] [Simpan]. Memilih produk/varian langsung tersimpan. */
export function SkuRow({ skuKey, items, suggest = [], kind: k0, itemId, variant, mapped = false }: { skuKey: string; items: { id: string; name: string; group: string }[]; suggest?: string[]; kind: "PRODUK" | "EXTRA_PACKING"; itemId?: string; variant?: string | null; mapped?: boolean }) {
  const [kind, setKind] = useState(k0);
  // SKU yang sudah dipetakan: tampil ringkas dengan tombol Edit; formulir baru muncul saat Edit ditekan
  const [editing, setEditing] = useState(!mapped);
  const form = useRef<HTMLDivElement>(null);
  // dropdown dikelompokkan per produk induk; saran di paling atas
  const byId = new Map(items.filter((i) => suggest.includes(i.id)).map((i) => [i.id, i]));
  const groups = [...items.reduce((m, i) => m.set(i.group, [...(m.get(i.group) ?? []), i]), new Map<string, typeof items>())].sort((a, b) => a[0].localeCompare(b[0]));
  const submit = () => form.current?.closest("form")?.requestSubmit();
  if (!editing) return <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setEditing(true)}>Edit</button>;
  return (
    <ActionForm action={mapSkuAction} className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center" onSuccess={mapped ? () => setEditing(false) : undefined}>
      <div ref={form} className="contents" />
      <input type="hidden" name="key" value={skuKey} />
      <input type="hidden" name="kind" value={kind} />
      <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-300 text-xs font-medium" role="group" aria-label="Jenis">
        {(["PRODUK", "EXTRA_PACKING"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`whitespace-nowrap px-3 py-1.5 ${kind === k ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            {k === "PRODUK" ? "Produk jadi" : "Extra Packing"}
          </button>
        ))}
      </div>
      {kind === "PRODUK" ? (
        <select name="itemId" data-dropdown data-nowrap data-panel-min="440" className="input w-full min-w-0 sm:w-64" defaultValue={itemId ?? ""} required onChange={(e) => e.target.value && setTimeout(submit, 0)}>
          <option value="">Pilih produk…</option>
          {byId.size > 0 && <optgroup label="Saran (toko yang benar dulu)">{suggest.map((id) => <option key={`s${id}`} value={id}>{byId.get(id)!.name}</option>)}</optgroup>}
          {groups.map(([g, list]) => <optgroup key={g} label={g}>{list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>)}
        </select>
      ) : (
        <select name="variant" className="input w-full min-w-0 sm:w-64" defaultValue={variant ?? VARIANTS[0]} onChange={() => setTimeout(submit, 0)}>
          {VARIANTS.map((v) => <option key={v}>{v}</option>)}
        </select>
      )}
      <Submit className="btn-secondary shrink-0 whitespace-nowrap" pendingText="…">Simpan</Submit>
      {mapped && <button type="button" className="btn-secondary shrink-0 whitespace-nowrap" onClick={() => setEditing(false)}>Batal</button>}
    </ActionForm>
  );
}
