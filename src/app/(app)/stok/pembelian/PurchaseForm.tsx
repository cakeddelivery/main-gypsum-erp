"use client";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { readPaymentProof } from "./actions";

type Item = { id: string; sku: string; name: string; unit: string; lastCost: number };
type Opt = { id: string; name: string };

const num = (s: string) => Number(s.replace(/\./g, "").replace(",", ".")) || 0;
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;

/**
 * Form pembelian: satu supplier di atas, banyak item di bawahnya (isi jumlah & total harga per item,
 * harga per satuan dihitung otomatis). Tagihan vs nominal dibayar menentukan status Lunas / Hutang.
 */
export function PurchaseFields({ items, suppliers, banks, stores, today, defaultBank, defaultStore }: { items: Item[]; suppliers: Opt[]; banks: Opt[]; stores: Opt[]; today: string; defaultBank?: string; defaultStore?: string }) {
  const [rows, setRows] = useState([{ k: 0, itemId: "", qty: "", total: "" }]);
  const [newSupplier, setNewSupplier] = useState(false);
  const [paid, setPaid] = useState("");
  const [bank, setBank] = useState(defaultBank ?? banks[0]?.id ?? "");
  const [reading, setReading] = useState(false);
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const proofRef = useRef<HTMLInputElement>(null);
  const bill = Math.round(rows.reduce((s, r) => s + num(r.total), 0));
  const paidN = num(paid);
  const debt = bill - paidN;
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));

  const readProof = async () => {
    const f = proofRef.current?.files?.[0];
    if (!f) return setHint({ ok: false, text: "Pilih foto bukti transfer dulu" });
    setReading(true);
    setHint(null);
    try {
      const fd = new FormData();
      fd.set("proof", f);
      const r = await readPaymentProof(fd);
      if (!r.ok) return setHint({ ok: false, text: r.error ?? "Gagal membaca foto" });
      if (r.amount) setPaid(String(r.amount));
      if (r.bankAccountId) setBank(r.bankAccountId);
      setHint({ ok: true, text: `Terbaca ${rp(r.amount ?? 0)}${r.date ? ` · ${r.date}` : ""}${r.counterparty ? ` · ke ${r.counterparty}` : ""}. Periksa sebelum menyimpan.` });
    } catch {
      setHint({ ok: false, text: "Gagal membaca foto. Isi nominal manual ya." });
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Tanggal transaksi</span><input type="date" name="date" defaultValue={today} className="input" required /></label>
        <div className="sm:col-span-2">
          <span className="label">Supplier / toko</span>
          {newSupplier ? (
            <div className="flex gap-2">
              <input name="newSupplierName" className="input" placeholder="Nama supplier baru (otomatis masuk menu Supplier)" required autoFocus />
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewSupplier(false)}>Batal</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><select name="supplierId" className="input" required defaultValue=""><option value="" disabled>— pilih supplier —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewSupplier(true)}>+ Baru</button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bahan baku yang dibeli</p>
        {rows.map((r, i) => {
          const it = items.find((x) => x.id === r.itemId);
          const per = num(r.qty) > 0 ? num(r.total) / num(r.qty) : 0;
          return (
            <div key={r.k} className="grid grid-cols-12 items-start gap-2 border-b border-slate-100 pb-2 last:border-0">
              <div className="col-span-12 sm:col-span-5">
                <select name="itemId" value={r.itemId} className="input" required onChange={(e) => set(i, { itemId: e.target.value })}>
                  <option value="" disabled>— pilih bahan baku —</option>
                  {items.map((x) => <option key={x.id} value={x.id}>{x.sku} {x.name} ({x.unit})</option>)}
                </select>
                {it && it.lastCost > 0 && <p className="mt-1 text-xs text-slate-500">Harga terakhir {rp(it.lastCost)}/{it.unit}</p>}
              </div>
              <label className="col-span-5 sm:col-span-2"><span className="sr-only">Jumlah</span><input name="qty" inputMode="decimal" placeholder={`Jumlah${it ? ` (${it.unit})` : ""}`} value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input" required /></label>
              <label className="col-span-7 sm:col-span-4"><span className="sr-only">Total harga</span><input name="lineTotal" inputMode="numeric" placeholder="Total harga (Rp)" value={r.total} onChange={(e) => set(i, { total: e.target.value })} className="input" required />
                <span className="mt-1 block text-xs text-emerald-700">{per > 0 ? `${rp(per)} / ${it?.unit ?? "satuan"}` : "harga per satuan otomatis"}</span>
              </label>
              <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm col-span-12 justify-self-end sm:col-span-1 sm:justify-self-auto" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
            </div>
          );
        })}
        <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "", total: "" }])}>+ Tambah item</button>
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
        <div className="flex items-center justify-between text-sm"><span className="text-slate-600">Tagihan</span><b className="text-lg">{rp(bill)}</b></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className="label">Foto bukti transfer (opsional, untuk isi nominal otomatis)</span>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={proofRef} type="file" name="proof" accept="image/jpeg,image/png,image/webp" className="min-w-0 flex-1 text-sm" onChange={() => setHint(null)} />
              <button type="button" className="btn-secondary btn-sm" disabled={reading} onClick={readProof}>{reading ? "Membaca…" : "✨ Baca nominal"}</button>
            </div>
            {hint && <p className={`mt-1 text-xs ${hint.ok ? "text-emerald-700" : "text-rose-600"}`}>{hint.text}</p>}
          </div>
          <label>
            <span className="label">Nominal pembayaran (Rp)</span>
            <div className="flex gap-2">
              <input name="paidAmount" inputMode="numeric" value={paid} onChange={(e) => setPaid(e.target.value)} className="input" placeholder="0 = belum dibayar" />
              <button type="button" className="btn-secondary btn-sm shrink-0" disabled={!bill} onClick={() => setPaid(String(bill))}>= Tagihan</button>
            </div>
          </label>
          <div>
            <span className="label">Status pembayaran</span>
            <div className="flex min-h-[2.5rem] items-center gap-2">
              {paidN > bill ? <Badge tone="red">Melebihi tagihan</Badge> : debt > 0 ? <><Badge tone="amber">Hutang</Badge><span className="text-sm">sisa {rp(debt)}</span></> : bill > 0 ? <Badge tone="green">Lunas</Badge> : <span className="text-sm text-slate-400">isi item dulu</span>}
            </div>
          </div>
          {paidN > 0 && <label><span className="label">Sumber rekening / dompet</span><select name="bankAccountId" value={bank} onChange={(e) => setBank(e.target.value)} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
          {debt > 0 && paidN <= bill && <label><span className="label">Jatuh tempo sisa hutang</span><input type="date" name="dueDate" className="input" required /></label>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Toko</span><select name="storeId" defaultValue={defaultStore} className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="sm:col-span-2"><span className="label">Catatan</span><input name="note" className="input" placeholder="cth: beli 5 sak gypsum super casting" /></label>
      </div>
      <p className="text-xs text-amber-700">Pembelian di sini sudah menambah stok dan membukukan pembayarannya. Jangan dicatat lagi di Finance Inbox agar tidak dobel. Sisa hutang dibayar lewat Akuntansi › Piutang, utang & pinjaman.</p>
    </div>
  );
}
