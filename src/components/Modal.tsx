"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";

const Ctx = createContext<() => void>(() => {});
export const useCloseModal = () => useContext(Ctx);

export function Modal({ trigger, title, children, triggerClass = "btn-primary", wide, defaultOpen = false }: { trigger: React.ReactNode; title: string; children: React.ReactNode; triggerClass?: string; wide?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        className={`w-[calc(100%-1.5rem)] ${wide ? "max-w-3xl" : "max-w-lg"} rounded-2xl p-0 shadow-xl backdrop:bg-slate-900/40`}
      >
        {open && (
          <Ctx.Provider value={() => setOpen(false)}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="font-semibold">{title}</h2>
              <button type="button" aria-label="Tutup" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <div className="max-h-[75vh] overflow-y-auto px-5 py-4">{children}</div>
          </Ctx.Provider>
        )}
      </dialog>
    </>
  );
}
