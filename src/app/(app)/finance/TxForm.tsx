"use client";
import { useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { useCloseModal } from "@/components/Modal";
import type { ActionResult } from "@/lib/action";
import type { Extraction } from "@/lib/extract";

type Opt = { id: string; name: string };
type Cat = Opt & { direction: string };
type Init = { id?: string; direction?: string; amount?: number; date?: string; time?: string; accountId?: string | null; toAccountId?: string | null; categoryId?: string | null; storeId?: string | null; counterparty?: string | null; note?: string | null; rawText?: string | null };

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
}) {
  const close = useCloseModal();
  const [v, setV] = useState<Init>(p.init);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const set = (k: keyof Init) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((o) => ({ ...o, [k]: e.target.value }));
  const cats = p.categories.filter((c) => c.direction === v.direction);
  // Toko hanya membedakan withdraw saldo penjual marketplace (transfer internal); selain itu selalu toko default.
  const isTransfer = v.direction === "TRANSFER";
  const storeIn = (text?: string | null) => p.stores.find((s) => text?.toLowerCase().includes(s.name.toLowerCase()))?.id;
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
                  accountId: ex.accountId ?? o.accountId,
                  toAccountId: ex.toAccountId ?? o.toAccountId,
                  categoryId: ex.categoryId ?? o.categoryId,
                  note: o.note || ex.note,
                  storeId: storeIn(v.rawText) ?? o.storeId,
                }));
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
        <label><span className="label">Jam (WIB)</span><input type="time" name="time" value={v.time ?? "12:00"} onChange={set("time")} className="input" /></label>
        <label><span className="label">{v.direction === "TRANSFER" ? "Dari rekening" : "Rekening"}</span>
          <select name="accountId" value={v.accountId ?? ""} onChange={set("accountId")} className="input"><option value="">— pilih —</option>{p.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        </label>
        {v.direction === "TRANSFER" ? (
          <label><span className="label">Ke rekening</span>
            <select name="toAccountId" value={v.toAccountId ?? ""} onChange={set("toAccountId")} className="input"><option value="">— pilih —</option>{p.banks.filter((b) => b.id !== v.accountId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        ) : (
          <label><span className="label">Kategori</span>
            <select name="categoryId" value={v.categoryId ?? ""} onChange={set("categoryId")} className="input"><option value="">— pilih —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        )}
        <label><span className="label">Pihak terkait</span><input name="counterparty" value={v.counterparty ?? ""} onChange={set("counterparty")} className="input" placeholder="Supplier / pelanggan" /></label>
        <label className="col-span-2 md:col-span-1"><span className="label">Bukti (JPG/PNG/PDF, maks 5 MB)</span><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="input py-1.5" /></label>
        <label className="col-span-2 md:col-span-3"><span className="label">Catatan</span><textarea name="note" value={v.note ?? ""} onChange={set("note")} rows={2} className="input" /></label>
      </div>
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
