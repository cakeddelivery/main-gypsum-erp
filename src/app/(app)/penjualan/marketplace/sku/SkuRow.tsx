"use client";
import { useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { mapSkuAction } from "../actions";

const VARIANTS = ["Bubble Wrap", "Extra Dus", "Extra Dus + Bubble Wrap"];

/** Pilih sekali: produk ERP, atau tandai Extra Packing (bukan produk jadi) */
export function SkuRow({ skuKey, items, kind: k0, itemId, variant }: { skuKey: string; items: { id: string; name: string }[]; kind: "PRODUK" | "EXTRA_PACKING"; itemId?: string; variant?: string | null }) {
  const [kind, setKind] = useState(k0);
  return (
    <ActionForm action={mapSkuAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="key" value={skuKey} />
      <select name="kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="PRODUK">Produk jadi</option>
        <option value="EXTRA_PACKING">Extra Packing</option>
      </select>
      {kind === "PRODUK" ? (
        <select name="itemId" className="input w-auto max-w-[16rem]" defaultValue={itemId ?? ""} required>
          <option value="">Pilih produk…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      ) : (
        <select name="variant" className="input w-auto" defaultValue={variant ?? VARIANTS[0]}>
          {VARIANTS.map((v) => <option key={v}>{v}</option>)}
        </select>
      )}
      <Submit className="btn-secondary" pendingText="…">Simpan</Submit>
    </ActionForm>
  );
}
