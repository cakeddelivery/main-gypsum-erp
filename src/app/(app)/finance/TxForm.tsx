"use client";
import { useEffect, useState } from "react";
import { nowTimeStr, todayStr } from "@/lib/time";
import { ActionForm, Submit } from "@/components/ActionForm";
import { useCloseModal } from "@/components/Modal";
import type { ActionResult } from "@/lib/action";
import type { Extraction } from "@/lib/extract";

type Opt = { id: string; name: string };
type Cat = Opt & { direction: string };
type Init = { id?: string; direction?: string; amount?: number; date?: string; time?: string; accountId?: string | null; toAccountId?: string | null; categoryId?: string | null; payableId?: string | null; storeId?: string | null; counterparty?: string | null; note?: string | null; rawText?: string | null; splits?: Split[] };
type Split = { categoryId: string | null; amount: number | ""; note: string; itemId?: string | null; itemName?: string | null; qty?: number | null };

export function TxForm(p: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  extract?: (text: string) => Promise<Extraction>;
  banks: Opt[];
  categories: Cat[];
  stores: Opt[];
  /** Toko default; dipakai untuk semua transaksi selain withdraw (operasional & bahan baku dipakai bersama) */
  defaultStoreId?: string | null;
  init: Init;
  mode: "create" | "edit";
  /** Hutang supplier / pinjaman yang belum lunas: pengeluaran bisa langsung dicatat sebagai pembayarannya */
  payables?: { id: string; label: string; vendor: string }[];
}) {
  const close = useCloseModal();
  const [v, setV] = useState<Init>(p.init);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  // Jam ikut jam sekarang (WIB) sampai diubah manual, terisi dari pesan, atau tanggalnya bukan hari ini
  const [timeAuto, setTimeAuto] = useState(p.mode === "create" && !p.init.time);
  useEffect(() => {
    if (!timeAuto) return;
    const tick = () => setV((o) => (o.date === todayStr() ? { ...o, time: nowTimeStr() } : o));
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, [timeAuto]);
  const set = (k: keyof Init) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((o) => ({ ...o, [k]: e.target.value }));
  const cats = p.categories.filter((c) => c.direction === v.direction);
  // Rincian: satu transfer dipecah ke beberapa kategori (jumlahnya harus = nominal)
  const [splits, setSplits] = useState<Split[]>(p.init.splits ?? []);
  const splitSum = splits.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const setSplit = (k: number, patch: Partial<Split>) => setSplits((o) => o.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  // Toko hanya membedakan withdraw saldo penjual marketplace (transfer internal); selain itu selalu toko default.
  const isTransfer = v.direction === "TRANSFER";
  // Toko dari nama atau inisial (WD MG / WD DL)
  const storeIn = (text?: string | null) => p.stores.find((s) => text?.toLowerCase().includes(s.name.toLowerCase()) || new RegExp(`\\b${(s as Opt & { code?: string }).code ?? "@@"}\\b`, "i").test(text ?? ""))?.id;
  return (
    <ActionForm action={p.action} className="space-y-4" onSuccess={() => setTimeout(close, 700)}>
      {v.id && <input type="hidden" name="id" value={v.id} />}
      {p.mode === "create" && <input type="hidden" name="formKey" value={formKey} />}
      {p.extract && (
        <div className="rounded-lg border border-dashed border-brand-200 bg-brand-50/50 p-3">
          <label className="label">Tempel pesan / catatan transaksi (opsional) — sistem membantu mengisi form</label>
          <textarea name="rawText" value={v.rawText ?? ""} onChange={set("rawText")} rows={2} className="input" placeholder="cth: bayar listrik 350rb dari seabank hari ini" />
          <button
            type="button"
            className="btn-secondary btn-sm mt-2"
            disabled={busy || !v.rawText}
            onClick={async () => {
              setBusy(true);
              try {
                const ex = await p.extract!(v.rawText ?? "");
                setV((o) => ({
                  ...o,
                  direction: ex.direction ?? o.direction,
                  amount: ex.amount ?? o.amount,
                  date: ex.date ?? o.date,
                  time: ex.time ?? o.time,
                  accountId: ex.accountId ?? o.accountId,
                  toAccountId: ex.toAccountId ?? o.toAccountId,
                  categoryId: ex.categoryId ?? o.categoryId,
                  payableId: ex.payableId ?? o.payableId,
                  note: o.note || ex.note,
                  storeId: storeIn(v.rawText) ?? o.storeId,
                }));
                if (ex.time) setTimeAuto(false);
                setHint(ex.missing.length ? `Terisi otomatis. Periksa: ${ex.missing.join(", ")}` : "Semua kolom terisi otomatis — periksa sebelum menyimpan.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Membaca…" : "✨ Ekstrak otomatis"}
          </button>
          {hint && <p className="mt-1 text-xs text-brand-700">{hint}</p>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label><span className="label">Jenis</span>
          <select name="direction" value={v.direction} onChange={set("direction")} className="input">
            <option value="MASUK">Pemasukan</option><option value="KELUAR">Pengeluaran</option><option value="TRANSFER">Transfer internal</option>
          </select>
        </label>
        <label><span className="label">Nominal (IDR)</span><input name="amount" inputMode="numeric" value={v.amount ?? ""} onChange={set("amount")} className="input" required placeholder="0" /></label>
        {isTransfer ? (
          <label><span className="label">Toko (withdraw)</span><select name="storeId" value={v.storeId ?? p.defaultStoreId ?? ""} onChange={set("storeId")} className="input">{p.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        ) : (
          <input type="hidden" name="storeId" value={p.defaultStoreId ?? v.storeId ?? ""} />
        )}
        <label><span className="label">Tanggal</span><input type="date" name="date" value={v.date ?? ""} onChange={set("date")} className="input" required /></label>
        <label><span className="label">Jam (WIB)</span><input type="time" name="time" value={v.time ?? "12:00"} onChange={(e) => { setTimeAuto(false); set("time")(e); }} className="input" />{timeAuto && <span className="mt-0.5 block text-xs text-slate-500">Otomatis jam sekarang</span>}</label>
        <label><span className="label">{v.direction === "TRANSFER" ? "Dari rekening" : "Rekening"}</span>
          <select name="accountId" value={v.accountId ?? ""} onChange={set("accountId")} className="input"><option value="">— pilih —</option>{p.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        </label>
        {v.direction === "TRANSFER" ? (
          <label><span className="label">Ke rekening</span>
            <select name="toAccountId" value={v.toAccountId ?? ""} onChange={set("toAccountId")} className="input"><option value="">— pilih —</option>{p.banks.filter((b) => b.id !== v.accountId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        ) : v.direction === "KELUAR" && v.payableId && !splits.length ? (
          <div><span className="label">Kategori</span><p className="py-2 text-sm text-slate-500">Bayar hutang (lihat di bawah)</p></div>
        ) : splits.length ? (
          <div><span className="label">Kategori</span><p className="py-2 text-sm text-slate-500">Dari rincian di bawah</p></div>
        ) : (
          <label><span className="label">Kategori</span>
            <select name="categoryId" value={v.categoryId ?? ""} onChange={set("categoryId")} className="input"><option value="">— pilih —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        )}
        {v.direction === "KELUAR" && !splits.length && (p.payables?.length ?? 0) > 0 && (
          <>
            <label className="col-span-2"><span className="label">Bayar hutang supplier / cicilan pinjaman (opsional)</span>
              <select name="payableId" value={v.payableId ?? ""} onChange={(e) => { const id = e.target.value; setV((o) => ({ ...o, payableId: id || null, counterparty: o.counterparty || p.payables!.find((x) => x.id === id)?.vendor || null })); }} className="input">
                <option value="">— bukan bayar hutang —</option>
                {p.payables!.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <span className="mt-0.5 block text-xs text-slate-500">Dipilih = sisa hutang supplier/pinjaman ikut berkurang saat dibukukan.</span>
            </label>
            {v.payableId && <label><span className="label">Bunga / biaya (opsional)</span><input name="payInterest" inputMode="numeric" className="input" placeholder="0" /><span className="mt-0.5 block text-xs text-slate-500">Khusus pinjaman; sisanya mengurangi pokok</span></label>}
          </>
        )}
        <label><span className="label">Pihak terkait (opsional)</span><input name="counterparty" value={v.counterparty ?? ""} onChange={set("counterparty")} className="input" placeholder="Nama toko / supplier / pembeli" /><span className="mt-0.5 block text-xs text-slate-500">Siapa penerima/pengirim uang. Untuk pencarian & cek duplikat.</span></label>
        <label className="col-span-2 md:col-span-1"><span className="label">Bukti (JPG/PNG/PDF, maks 15 MB)</span><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="input py-1.5" /></label>
        <label className="col-span-2 md:col-span-3"><span className="label">Catatan</span><textarea name="note" value={v.note ?? ""} onChange={set("note")} rows={2} className="input" /></label>
      </div>
      {!isTransfer && (
        <div className="rounded-lg border border-slate-200 p-3">
          <input type="hidden" name="splitsOn" value="1" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label !mb-0">Rincian (opsional) — satu transfer untuk beberapa keperluan</span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setSplits((o): Split[] => [...(o.length ? o : [{ categoryId: v.categoryId ?? null, amount: (Number(v.amount) || "") as number | "", note: "" }]), { categoryId: null, amount: "", note: "" }])}>+ Rincian</button>
          </div>
          {splits.length > 0 && (
            <div className="mt-2 space-y-2">
              {splits.map((x, k) => (
                <div key={k} className="grid grid-cols-12 items-center gap-2">
                  <input type="hidden" name="splitItem" value={x.itemId ?? ""} />
                  <input type="hidden" name="splitQty" value={x.qty ?? ""} />
                  <input name="splitNote" value={x.note} onChange={(e) => setSplit(k, { note: e.target.value })} className="input col-span-12 sm:col-span-4" placeholder="Keterangan, cth: galon" />
                  {x.itemId ? (
                    <span className="col-span-7 text-sm sm:col-span-4">📦 Stok {x.itemName} × {x.qty}<input type="hidden" name="splitCat" value="" /></span>
                  ) : (
                    <select name="splitCat" value={x.categoryId ?? ""} onChange={(e) => setSplit(k, { categoryId: e.target.value || null })} className="input col-span-7 sm:col-span-4" data-plain=""><option value="">— kategori —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  )}
                  <input name="splitAmount" value={x.amount} onChange={(e) => setSplit(k, { amount: e.target.value === "" ? "" : Number(e.target.value.replace(/\D/g, "")) })} inputMode="numeric" className="input col-span-4 sm:col-span-3" placeholder="Nominal" />
                  <button type="button" className="col-span-1 text-slate-400 hover:text-rose-600" title="Hapus rincian" onClick={() => setSplits((o) => o.filter((_, i) => i !== k))}>✕</button>
                </div>
              ))}
              <p className={`text-xs ${splitSum === Number(v.amount) ? "text-emerald-700" : "text-rose-600"}`}>
                Total rincian Rp {splitSum.toLocaleString("id-ID")} {splitSum === Number(v.amount) ? "= nominal ✓" : `≠ nominal Rp ${Number(v.amount || 0).toLocaleString("id-ID")}`}
                {splitSum !== Number(v.amount) && splitSum > 0 && <button type="button" className="link ml-2" onClick={() => setV((o) => ({ ...o, amount: splitSum }))}>Pakai total rincian</button>}
              </p>
            </div>
          )}
        </div>
      )}
      {isTransfer && <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Transfer internal hanya memindahkan saldo antar rekening — tidak dicatat sebagai pendapatan atau beban. Pilih toko bila ini withdraw saldo penjual marketplace.</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {p.mode === "create" ? (
          <>
            <Submit className="btn-secondary" name="intent" value="draft">Simpan draft</Submit>
            <Submit name="intent" value="submit">Simpan & ajukan konfirmasi</Submit>
          </>
        ) : (
          <Submit>Simpan perubahan</Submit>
        )}
      </div>
    </ActionForm>
  );
}
