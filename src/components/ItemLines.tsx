"use client";
import { useState } from "react";

type Opt = { id: string; name: string; unit?: string; stock?: number };

/** Baris barang + jumlah (kirim bahan, kirim hasil, bahan per pcs tugas) */
export function ItemLines({ items, initial = [], qtyLabel = "Jumlah", emptyLabel = "— pilih barang —", name = "itemId" }: { items: Opt[]; initial?: { itemId: string; qty: number }[]; qtyLabel?: string; emptyLabel?: string; name?: string }) {
  const [rows, setRows] = useState(initial.length ? initial.map((r, k) => ({ k, itemId: r.itemId, qty: String(r.qty) })) : [{ k: 0, itemId: "", qty: "" }]);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const it = items.find((x) => x.id === r.itemId);
        return (
          <div key={r.k} className="grid grid-cols-12 items-start gap-2 [&>*]:min-w-0">
            <div className="col-span-12 sm:col-span-7">
              <select name={name} value={r.itemId} className="input" onChange={(e) => set(i, { itemId: e.target.value })}>
                <option value="" disabled>{emptyLabel}</option>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ""}</option>)}
              </select>
              {it?.stock !== undefined && <p className="mt-1 text-xs text-slate-500">Stok tersedia {it.stock.toLocaleString("id-ID")} {it.unit}</p>}
            </div>
            <input name="qty" inputMode="decimal" placeholder={`${qtyLabel}${it?.unit ? ` (${it.unit})` : ""}`} value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input col-span-9 sm:col-span-4" />
            <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm col-span-3 sm:col-span-1" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ k: Date.now(), itemId: "", qty: "" }]))}>×</button>
          </div>
        );
      })}
      <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "" }])}>+ Tambah Baris</button>
    </div>
  );
}
