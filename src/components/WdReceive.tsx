"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm, Submit } from "./ActionForm";
import { CLOSE_MS } from "./Modal";
import type { ActionResult } from "@/lib/action";

type Bank = { id: string; name: string };
type Act = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** Isian "Uang diterima": tanggal & jam terima (bawaan: sekarang) + rekening tujuan (terisi) */
export function WdReceiveFields({ id, toAccountId, banks, date, time, compact }: { id: string; toAccountId: string | null; banks: Bank[]; date: string; time: string; compact?: boolean }) {
  return (
    <>
      <input type="hidden" name="id" value={id} />
      <div className={compact ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "grid grid-cols-2 gap-3"}>
        <label className="block text-xs text-slate-600">
          Tanggal terima
          <input type="date" name="date" defaultValue={date} max={date} required className="input mt-1" />
        </label>
        <label className="block text-xs text-slate-600">
          Jam terima
          <input type="time" name="time" defaultValue={time} required className="input mt-1" />
        </label>
        <label className={`block text-xs text-slate-600 ${compact ? "col-span-2 sm:col-span-1" : "col-span-2"}`}>
          Masuk ke rekening
          <select name="toAccountId" defaultValue={toAccountId ?? ""} required className="input mt-1">
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

export type PopupRow = { id: string; number: string; amount: string; label: string; toAccountId: string | null };

/**
 * Popup otomatis di Beranda: daftar withdraw TikTok Dalam Proses. Muncul sekali per hari per pengguna
 * (diingat di browser). Tiap baris punya tombol "Uang diterima"; baris yang sudah dibukukan hilang dari popup.
 */
export function WdProcessPopup({ rows: initial, banks, action, userKey, date, time }: { rows: PopupRow[]; banks: Bank[]; action: Act; userKey: string; date: string; time: string }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const key = `wdProsesPopup:${userKey}`;
  useEffect(() => {
    if (!initial.length) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(key);
    } catch {}
    if (seen === date) return;
    setOpen(true);
    try {
      window.localStorage.setItem(key, date);
    } catch {}
  }, [initial.length, key, date]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
  }, []);
  useEffect(() => {
    if (open && !rows.length) close();
  }, [open, rows.length, close]);
  if (!initial.length) return null;
  return (
    <dialog
      ref={ref}
      data-closing={closing || undefined}
      onClose={() => setOpen(false)}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="modal w-[calc(100%-1.5rem)] max-w-2xl rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50"
    >
      {open && (
        <div>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <h2 className="font-semibold text-slate-900">⏳ Withdraw TikTok dalam proses</h2>
            <button type="button" aria-label="Tutup" className="rounded p-1 text-slate-600 hover:bg-slate-100" onClick={close}>
              ✕
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4 supports-[height:100dvh]:max-h-[70dvh]">
            <p className="mb-3 text-sm text-slate-600">Uangnya belum masuk rekening, jadi belum menambah saldo. Tekan <b>Uang diterima</b> bila sudah masuk.</p>
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-slate-500">{r.number}</div>
                      <div className="text-sm">{r.label}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums text-emerald-700">{r.amount}</span>
                      {openRow !== r.id && (
                        <button type="button" className="btn-success btn-sm" onClick={() => setOpenRow(r.id)}>
                          💰 Uang diterima
                        </button>
                      )}
                    </div>
                  </div>
                  {openRow === r.id && (
                    <ActionForm action={action} className="mt-3 space-y-2" onSuccess={() => setRows((x) => x.filter((y) => y.id !== r.id))}>
                      <WdReceiveFields id={r.id} toAccountId={r.toAccountId} banks={banks} date={date} time={time} compact />
                      <div className="flex justify-end gap-2">
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpenRow(null)}>
                          Batal
                        </button>
                        <Submit className="btn-success btn-sm" pendingText="Membukukan…">
                          Simpan: uang diterima
                        </Submit>
                      </div>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end border-t border-slate-200 px-5 py-3">
            <button type="button" className="btn-secondary" onClick={close}>
              Tutup
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
