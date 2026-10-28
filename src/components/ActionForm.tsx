"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/action";
import { toast } from "./Toaster";

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

/** Form dengan state loading / error / sukses untuk server action */
export function ActionForm({ action, children, className, resetOnSuccess, onSuccess, confirm, persist }: Props) {
  // Toast dipicu langsung setelah respons server, sebelum form bisa hilang karena data ter-render ulang
  const [state, formAction] = useActionState(async (prev: ActionResult | null, fd: FormData) => {
    const r = await action(prev, fd);
    if (r?.ok && !persist) toast(r.message ?? "Tersimpan");
    return r;
  }, null);
  const ref = useRef<HTMLFormElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!state) return;
    setVisible(true);
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.();
      if (!persist) setVisible(false);
    }
  }, [state, resetOnSuccess, onSuccess, persist]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {visible && state && (
        <div role="status" className={`mt-3 break-all rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
          {state.ok ? `✓ ${state.message}` : state.error}
        </div>
      )}
    </form>
  );
}

export function Submit({ children, className = "btn-primary", pendingText = "Menyimpan…", name, value }: { children: React.ReactNode; className?: string; pendingText?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} name={name} value={value}>
      {pending ? (
        <>
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {pendingText}
        </>
      ) : (
        children
      )}
    </button>
  );
}
