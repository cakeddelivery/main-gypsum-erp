"use client";
import { useState } from "react";

type Item = { id: string; sku: string; name: string; unit: string; avgCost: number };
type Opt = { id: string; name: string };

/** Form pembelian: baris item dinamis + cara bayar (lunas / DP bertahap / tempo) */
export function PurchaseFields({ items, suppliers, banks, stores, today, defaultBank, defaultStore }: { items: Item[]; suppliers: Opt[]; banks: Opt[]; stores: Opt[]; today: string; defaultBank?: string; defaultStore?: string }) {
  const [rows, setRows] = useState([{ k: 0, itemId: "", qty: "", cost: "" }]);
  const [term, setTerm] = useState("LUNAS");
  const num = (s: string) => Number(s.replace(/\./g, "").replace(",", ".")) || 0;
  const total = Math.round(rows.reduce((s, r) => s + num(r.qty) * num(r.cost), 0));
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Supplier</span><select name="supplierId" className="input"><option value="">— lainnya —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label><span className="label">Nama supplier (bila lainnya)</span><input name="vendor" className="input" /></label>
        <label><span className="label">Tanggal</span><input type="date" name="date" defaultValue={today} className="input" /></label>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.k} className="grid grid-cols-12 gap-2">
            <select name="itemId" value={r.itemId} className="input col-span-12 sm:col-span-6" onChange={(e) => { const it = items.find((x) => x.id === e.target.value); set(i, { itemId: e.target.value, cost: r.cost || (it?.avgCost ? String(it.avgCost) : "") }); }}>
              <option value="">— item bahan baku —</option>
              {items.map((it) => <option key={it.id} value={it.id}>{it.sku} {it.name} ({it.unit})</option>)}
            </select>
            <input name="qty" inputMode="decimal" placeholder="Jumlah" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input col-span-4 sm:col-span-2" />
            <input name="unitCost" inputMode="numeric" placeholder="Harga satuan" value={r.cost} onChange={(e) => set(i, { cost: e.target.value })} className="input col-span-5 sm:col-span-3" />
            <button type="button" className="btn-secondary btn-sm col-span-3 sm:col-span-1" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "", cost: "" }])}>+ Item</button>
          <span className="text-sm">Total: <b>Rp {total.toLocaleString("id-ID")}</b></span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Cara bayar</span>
          <select name="term" value={term} onChange={(e) => setTerm(e.target.value)} className="input">
            <option value="LUNAS">Bayar di depan (lunas)</option>
            <option value="BERTAHAP">Bertahap (DP + cicilan)</option>
            <option value="TEMPO">Tempo (bayar nanti)</option>
          </select>
        </label>
        {term === "BERTAHAP" && <label><span className="label">DP dibayar sekarang</span><input name="paidNow" inputMode="numeric" className="input" required /></label>}
        {term !== "TEMPO" && <label><span className="label">Dibayar dari</span><select name="bankAccountId" defaultValue={defaultBank} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
        {term !== "LUNAS" && <label><span className="label">Jatuh tempo sisa</span><input type="date" name="dueDate" className="input" required /></label>}
        <label><span className="label">Toko</span><select name="storeId" defaultValue={defaultStore} className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="sm:col-span-2"><span className="label">Catatan</span><input name="note" className="input" /></label>
      </div>
      <p className="text-xs text-amber-700">Pembelian di sini sudah menambah stok dan membukukan pembayarannya. Jangan dicatat lagi di Finance Inbox agar tidak dobel. Cicilan sisa dibayar lewat Akuntansi › Piutang, utang & pinjaman.</p>
    </div>
  );
}
