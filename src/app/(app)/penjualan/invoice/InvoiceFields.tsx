"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

type Item = { id: string; name: string; unit: string };
type Stores = { id: string; name: string; code: string }[];
type Prices = Record<string, Partial<Record<"TTS" | "SHP" | "OFF", number>>>;
const CH = [["TTS", "TikTok Shop"], ["SHP", "Shopee"], ["OFF", "Offline"]] as const;

/** Isian invoice manual: toko, channel, pembeli, barang (harga terisi otomatis sesuai channel produk), diskon, ongkir */
export function InvoiceFields({ stores, items, prices, today }: { stores: Stores; items: Item[]; prices: Prices; today: string }) {
  const [channel, setChannel] = useState<"TTS" | "SHP" | "OFF">("TTS");
  const [rows, setRows] = useState([{ k: 0, itemId: "", qty: "1", price: "" }]);
  const priceOf = (itemId: string, ch = channel) => prices[itemId]?.[ch];
  const set = (i: number, p: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const pickItem = (i: number, itemId: string) => set(i, { itemId, price: priceOf(itemId) ? String(priceOf(itemId)) : "" });
  const switchChannel = (ch: "TTS" | "SHP" | "OFF") => { setChannel(ch); setRows((r) => r.map((x) => (x.itemId && priceOf(x.itemId, ch) ? { ...x, price: String(priceOf(x.itemId, ch)) } : x))); };
  const total = rows.reduce((a, r) => a + (Number(r.qty.replace(",", ".")) || 0) * (Number(r.price) || 0), 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 keep-cols">
        <Field label="Toko"><select name="storeId" className="input" required>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Channel"><select name="channel" className="input" value={channel} onChange={(e) => switchChannel(e.target.value as "TTS" | "SHP" | "OFF")}>{CH.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <div className="grid grid-cols-2 gap-3 keep-cols">
        <Field label="Tanggal"><input type="date" name="date" className="input" defaultValue={today} required /></Field>
        <Field label="Nama pembeli"><input name="customerName" className="input" required minLength={2} maxLength={120} placeholder="Nama / toko pembeli" /></Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Barang</div>
        {rows.map((r, i) => (
          <div key={r.k} className="space-y-1.5 rounded-lg border border-slate-200 p-2">
            <div className="flex items-center gap-1.5">
              <select name="itemId" value={r.itemId} onChange={(e) => pickItem(i, e.target.value)} className="input min-w-0 flex-1 px-2 text-sm" aria-label={`Barang ${i + 1}`}>
                <option value="">— pilih barang —</option>
                {items.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button type="button" className="grid h-9 w-7 shrink-0 place-items-center rounded-md text-rose-600 hover:bg-rose-50" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))} aria-label={`Hapus barang ${i + 1}`}>✕</button>
            </div>
            <div className="flex gap-1.5">
              <input name="qty" inputMode="decimal" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input w-20 px-2 text-right tabular-nums" placeholder="Qty" aria-label={`Jumlah ${i + 1}`} />
              <input name="price" inputMode="numeric" value={r.price} onChange={(e) => set(i, { price: e.target.value.replace(/\D/g, "") })} className="input min-w-0 flex-1 px-2 text-right tabular-nums" placeholder="Harga satuan (Rp)" aria-label={`Harga ${i + 1}`} />
            </div>
            {r.itemId && !priceOf(r.itemId) && <p className="text-xs text-amber-700">Belum ada harga channel ini di Produk &amp; HPP; isi manual.</p>}
          </div>
        ))}
        <button type="button" className="btn-secondary w-full" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "1", price: "" }])}>+ Tambah barang</button>
      </div>
      <div className="grid grid-cols-2 gap-3 keep-cols">
        <Field label="Diskon (Rp)"><input name="discount" inputMode="numeric" className="input" defaultValue="0" /></Field>
        <Field label="Ongkir (Rp)"><input name="shipping" inputMode="numeric" className="input" defaultValue="0" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="paid" value="1" defaultChecked /> Sudah dibayar (cap LUNAS)</label>
      <Field label="Catatan (opsional)"><input name="note" className="input" maxLength={300} /></Field>
      <p className="text-sm">Perkiraan jumlah harga: <b className="tabular-nums">Rp {Math.round(total).toLocaleString("id-ID")}</b></p>
    </>
  );
}
