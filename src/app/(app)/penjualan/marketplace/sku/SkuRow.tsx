"use client";
import { useRef, useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { mapSkuAction } from "../actions";

const VARIANTS = ["Bubble Wrap", "Extra Dus", "Extra Dus + Bubble Wrap"];

/** Satu baris rapi: [Produk jadi | Extra Packing] [pilihan] [Simpan]. Memilih produk/varian langsung tersimpan. */
export function SkuRow({ skuKey, items, kind: k0, itemId, variant }: { skuKey: string; items: { id: string; name: string }[]; kind: "PRODUK" | "EXTRA_PACKING"; itemId?: string; variant?: string | null }) {
  const [kind, setKind] = useState(k0);
  const form = useRef<HTMLDivElement>(null);
  const submit = () => form.current?.closest("form")?.requestSubmit();
  return (
    <ActionForm action={mapSkuAction} className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
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
        <select name="itemId" className="input w-full min-w-0 sm:w-64" defaultValue={itemId ?? ""} required onChange={(e) => e.target.value && setTimeout(submit, 0)}>
          <option value="">Pilih produk…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      ) : (
        <select name="variant" className="input w-full min-w-0 sm:w-64" defaultValue={variant ?? VARIANTS[0]} onChange={() => setTimeout(submit, 0)}>
          {VARIANTS.map((v) => <option key={v}>{v}</option>)}
        </select>
      )}
      <Submit className="btn-secondary shrink-0 whitespace-nowrap" pendingText="…">Simpan</Submit>
    </ActionForm>
  );
}
