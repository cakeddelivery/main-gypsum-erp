"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const Ctx = createContext<() => void>(() => {});
export const useCloseModal = () => useContext(Ctx);

/**
 * Popup form. Bila isian sudah diubah, menutup (✕, Esc, ketuk di luar popup) meminta konfirmasi dulu
 * agar isian tidak hilang tanpa sengaja. Setelah tersimpan, popup ditutup tanpa konfirmasi.
 */
export function Modal({ trigger, title, children, triggerClass = "btn-primary", wide, defaultOpen = false }: { trigger: React.ReactNode; title: string; children: React.ReactNode; triggerClass?: string; wide?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (!open) {
      setDirty(false);
      setAsking(false);
    }
  }, [open]);
  const forceClose = useCallback(() => setOpen(false), []);
  const requestClose = () => (dirty ? setAsking(true) : setOpen(false));
  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onCancel={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
        className={`w-[calc(100%-1.5rem)] ${wide ? "max-w-3xl" : "max-w-lg"} rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50`}
      >
        {open && (
          <Ctx.Provider value={forceClose}>
            <div className="relative" onInput={() => setDirty(true)} onChange={() => setDirty(true)}>
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
                <h2 className="font-semibold capitalize text-slate-900">{title}</h2>
                <button type="button" aria-label="Tutup" className="rounded p-1 text-slate-600 hover:bg-slate-100" onClick={requestClose}>
                  ✕
                </button>
              </div>
              <div className="max-h-[75vh] overflow-y-auto overflow-x-hidden overscroll-contain px-5 py-4 supports-[height:100dvh]:max-h-[75dvh]">{children}</div>
              {asking && (
                <div role="alertdialog" aria-labelledby="tutup-judul" className="absolute inset-0 z-10 grid place-items-center rounded-2xl bg-slate-900/50 p-4">
                  <div className="w-full max-w-sm rounded-xl border border-slate-300 bg-white p-4 shadow-2xl">
                    <p id="tutup-judul" className="font-semibold text-slate-900">⚠️ Tutup form?</p>
                    <p className="mt-1 text-sm text-slate-600">Isian yang belum disimpan akan hilang.</p>
                    <div className="mt-4 flex justify-end gap-2">
                      <button type="button" className="btn-secondary" onClick={() => setAsking(false)} autoFocus>
                        Lanjut mengisi
                      </button>
                      <button type="button" className="btn-danger" onClick={forceClose}>
                        Tutup
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Ctx.Provider>
        )}
      </dialog>
    </>
  );
}
