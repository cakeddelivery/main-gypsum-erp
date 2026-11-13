"use client";
import { createContext, useActionState, useContext, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/action";
import { toast } from "./Toaster";
import { revealField } from "./FormFeedback";

type Props = {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  onSuccess?: () => void;
  confirm?: string;
  /** Pesan sukses tetap tampil (mis. API key yang hanya ditampilkan sekali) */
  persist?: boolean;
};

/** true sesaat setelah form berhasil disimpan → tombol Simpan menampilkan tanda centang */
const DoneCtx = createContext<{ done: boolean; by: string | null }>({ done: false, by: null });
/** Lama tanda "✓ Berhasil" di tombol */
export const DONE_MS = 1400;

type State = (ActionResult & { n: number }) | null;

/** Form dengan state loading / error / sukses untuk server action */
export function ActionForm({ action, children, className, resetOnSuccess, onSuccess, confirm, persist }: Props) {
  // Toast dipicu langsung setelah respons server, sebelum form bisa hilang karena data ter-render ulang
  const [state, formAction] = useActionState(async (prev: State, fd: FormData): Promise<State> => {
    const r = await action(prev, fd);
    if (r?.ok && !persist) toast(r.message ?? "Tersimpan");
    // n berubah tiap kirim agar animasi pesan error diputar ulang walau pesannya sama
    return { ...r, n: (prev?.n ?? 0) + 1 };
  }, null);
  const ref = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(false);
  // Tombol kirim yang ditekan terakhir (name=value), agar centang hanya muncul di tombol itu
  const by = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    setVisible(true);
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.();
      if (!persist) setVisible(false);
      setDone(true);
      const t = window.setTimeout(() => setDone(false), DONE_MS);
      return () => window.clearTimeout(t);
    }
    // Gagal: pesan error digulir ke tengah layar agar terlihat (form panjang / di popup)
    setDone(false);
    if (msgRef.current) revealField(msgRef.current, false);
  }, [state, resetOnSuccess, onSuccess, persist]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) return e.preventDefault();
        const b = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        by.current = b?.name ? `${b.name}=${b.value}` : null;
      }}
    >
      <DoneCtx.Provider value={{ done, by: by.current }}>{children}</DoneCtx.Provider>
      {visible && state && (
        <div
          ref={msgRef}
          key={state.n}
          role={state.ok ? "status" : "alert"}
          className={`form-msg mt-3 [overflow-wrap:anywhere] rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-700" : "anim-shake bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200"}`}
        >
          {state.ok ? `✓ ${state.message}` : <>⚠️ {state.error}</>}
        </div>
      )}
    </form>
  );
}

/** Isi tombol kirim: pemutar saat memproses, centang singkat setelah berhasil */
export function SubmitLabel({ pending, done, pendingText, children }: { pending: boolean; done: boolean; pendingText: string; children: React.ReactNode }) {
  if (pending)
    return (
      <>
        <span className="btn-spinner" aria-hidden />
        {pendingText}
      </>
    );
  if (done)
    return (
      <span className="anim-check inline-flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" className="check-draw h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        Berhasil
      </span>
    );
  return <>{children}</>;
}

/** true bila tombol ini (name/value) baru saja berhasil mengirim form */
export function useSubmitDone(name?: string, value?: string) {
  const { done, by } = useContext(DoneCtx);
  return done && (!by || !name || by === `${name}=${value}`);
}

export function Submit({ children, className = "btn-primary", pendingText = "Menyimpan…", name, value, confirm }: { children: React.ReactNode; className?: string; pendingText?: string; name?: string; value?: string; /** Konfirmasi khusus tombol ini (mis. "Kirim" di form yang juga punya "Simpan draf") */ confirm?: string }) {
  const { pending, data } = useFormStatus();
  const done = useSubmitDone(name, value);
  // Bila form punya beberapa tombol kirim (mis. Draft / Ajukan), hanya tombol yang ditekan yang berputar
  const mine = !name || !data || data.get(name) === value;
  return (
    <button type="submit" className={`${className} ${pending && mine ? "is-pending" : ""} ${done ? "is-done" : ""}`} disabled={pending} aria-busy={pending && mine} name={name} value={value} onClick={(e) => {
        if (confirm && !window.confirm(confirm)) return e.preventDefault();
        // name/value tombol tidak selalu ikut terkirim lewat form action React → simpan di kolom tersembunyi
        const form = e.currentTarget.form;
        if (name && form) {
          let h = form.querySelector<HTMLInputElement>(`input[type=hidden][data-submitter="${name}"]`);
          if (!h) {
            h = document.createElement("input");
            h.type = "hidden";
            h.name = name;
            h.dataset.submitter = name;
            form.prepend(h);
          }
          h.value = value ?? "";
        }
      }}>
      <SubmitLabel pending={pending && mine} done={done && !pending} pendingText={pendingText}>
        {children}
      </SubmitLabel>
    </button>
  );
}
