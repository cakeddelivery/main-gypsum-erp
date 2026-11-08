"use client";
import { useState } from "react";
import { Badge } from "@/components/ui";

type Item = { id: string; name: string; unit: string; stock: number; price: number };
type Opt = { id: string; name: string };

const num = (s: string) => Number(s.replace(/\./g, "").replace(",", ".")) || 0;
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;

/**
 * Form penjualan offline: pelanggan di atas, banyak barang jadi di bawahnya (harga otomatis dari harga offline terakhir,
 * boleh diubah), lalu diskon per nota, ongkir, dan pembayaran. Kurang dari tagihan = piutang dengan jatuh tempo.
 */
export function SaleFields({ items, customers, banks, stores, today, defaultBank, defaultStore }: { items: Item[]; customers: Opt[]; banks: Opt[]; stores: Opt[]; today: string; defaultBank?: string; defaultStore?: string }) {
  const [rows, setRows] = useState([{ k: 0, itemId: "", qty: "1", price: "" }]);
  const [newCustomer, setNewCustomer] = useState(false);
  const [discount, setDiscount] = useState("");
  const [shipping, setShipping] = useState("");
  const [paid, setPaid] = useState("");
  const [bank, setBank] = useState(defaultBank ?? banks[0]?.id ?? "");
  const subtotal = Math.round(rows.reduce((s, r) => s + num(r.qty) * num(r.price), 0));
  const total = subtotal - num(discount) + num(shipping);
  const paidN = num(paid);
  const debt = total - paidN;
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Tanggal</span><input type="date" name="date" defaultValue={today} className="input" required /></label>
        <label className="sm:col-span-2"><span className="label">Toko</span><select name="storeId" defaultValue={defaultStore ?? stores[0]?.id} className="input" required>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="sm:col-span-3">
          <span className="label">Pelanggan</span>
          {newCustomer ? (
            <div className="flex flex-wrap gap-2 sm:flex-nowrap">
              <input name="newCustomerName" className="input" placeholder="Nama pelanggan baru (otomatis masuk menu Pelanggan)" required autoFocus />
              <input name="newCustomerPhone" className="input sm:max-w-[12rem]" inputMode="tel" placeholder="No. HP (opsional)" />
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewCustomer(false)}>Batal</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><select name="customerId" className="input" defaultValue=""><option value="">Pelanggan umum (tanpa nama)</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewCustomer(true)}>+ Baru</button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Barang yang dijual</p>
        {rows.map((r, i) => {
          const it = items.find((x) => x.id === r.itemId);
          const over = it && num(r.qty) > it.stock;
          return (
            <div key={r.k} className="grid grid-cols-12 items-start gap-2 border-b border-slate-100 pb-2 last:border-0 [&>*]:min-w-0">
              <div className="col-span-12 sm:col-span-5">
                <select name="itemId" value={r.itemId} className="input" required onChange={(e) => { const x = items.find((y) => y.id === e.target.value); set(i, { itemId: e.target.value, price: x?.price ? String(x.price) : r.price }); }}>
                  <option value="" disabled>— pilih produk jadi —</option>
                  {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                {it && <p className={`mt-1 text-xs ${over ? "text-amber-700" : "text-slate-500"}`}>Stok {it.stock.toLocaleString("id-ID")} {it.unit}{over ? " · kurang, stok akan minus" : ""}</p>}
              </div>
              <label className="col-span-4 sm:col-span-2"><span className="sr-only">Jumlah</span><input name="qty" inputMode="decimal" placeholder={`Jumlah${it ? ` (${it.unit})` : ""}`} value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input" required /></label>
              <label className="col-span-8 sm:col-span-4"><span className="sr-only">Harga satuan</span><input name="price" inputMode="numeric" placeholder="Harga satuan (Rp)" value={r.price} onChange={(e) => set(i, { price: e.target.value })} className="input" required />
                <span className="mt-1 block text-xs text-emerald-700">{num(r.qty) * num(r.price) > 0 ? `Jumlah ${rp(num(r.qty) * num(r.price))}` : "harga offline terakhir terisi otomatis"}</span>
              </label>
              <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm col-span-12 justify-self-end sm:col-span-1 sm:justify-self-auto" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
            </div>
          );
        })}
        <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "1", price: "" }])}>+ Tambah barang</button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label><span className="label">Diskon per nota (Rp)</span><input name="discount" inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} className="input" placeholder="0" /></label>
        <label><span className="label">Ongkir ditagih ke pembeli (Rp)</span><input name="shipping" inputMode="numeric" value={shipping} onChange={(e) => setShipping(e.target.value)} className="input" placeholder="0" /></label>
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-600">Jumlah harga barang</span><span>{rp(subtotal)}</span></div>
          {num(discount) > 0 && <div className="flex justify-between"><span className="text-slate-600">Diskon</span><span className="text-rose-600">−{rp(num(discount))}</span></div>}
          {num(shipping) > 0 && <div className="flex justify-between"><span className="text-slate-600">Ongkir</span><span>{rp(num(shipping))}</span></div>}
          <div className="flex items-center justify-between border-t border-emerald-200 pt-1"><span className="text-slate-600">Tagihan</span><b className="text-lg">{rp(total)}</b></div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <label>
            <span className="label">Dibayar sekarang (Rp)</span>
            <div className="flex min-w-0 gap-2">
              <input name="paidAmount" inputMode="numeric" value={paid} onChange={(e) => setPaid(e.target.value)} className="input" placeholder="0 = tempo" />
              <button type="button" className="btn-success btn-sm shrink-0" disabled={!(total > 0)} onClick={() => setPaid(String(total))}>Lunas</button>
            </div>
          </label>
          <div>
            <span className="label">Status pembayaran</span>
            <div className="flex min-h-[2.5rem] items-center gap-2">
              {num(discount) > subtotal ? <Badge tone="red">Diskon melebihi harga</Badge> : paidN > total ? <Badge tone="red">Melebihi tagihan</Badge> : total <= 0 ? <span className="text-sm text-slate-400">isi barang dulu</span> : debt <= 0 ? <Badge tone="green">Lunas</Badge> : <><Badge tone="amber">{paidN > 0 ? "Bayar sebagian" : "Tempo"}</Badge><span className="text-sm">piutang {rp(debt)}</span></>}
            </div>
          </div>
          {paidN > 0 && <label><span className="label">Masuk ke rekening</span><select name="bankAccountId" value={bank} onChange={(e) => setBank(e.target.value)} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
          {paidN > 0 && <label><span className="label">Bukti bayar (opsional)</span><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full min-w-0 max-w-full text-base" /></label>}
          {debt > 0 && paidN <= total && <label><span className="label">Jatuh tempo sisa tagihan</span><input type="date" name="dueDate" className="input" required /></label>}
        </div>
        {debt > 0 && !newCustomer && <p className="mt-2 text-xs text-amber-700">Tempo / bayar sebagian wajib memilih pelanggan.</p>}
      </div>

      <label className="block"><span className="label">Catatan</span><input name="note" className="input" placeholder="cth: pesanan via WA, diambil sendiri" /></label>
      <p className="text-xs text-amber-700">Penjualan di sini sudah membukukan pendapatan, mengurangi stok barang jadi, dan mencatat HPP. Jangan dicatat lagi di menu Transaksi agar tidak dobel. Penjualan marketplace tidak dicatat di sini (pendapatannya dari withdraw).</p>
    </div>
  );
}
