"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CLOSE_MS } from "./Modal";
import { todayStr } from "@/lib/time";

const KEY = "mg_email_reminder";

/**
 * Pengingat isi Gmail untuk akun yang belum punya email: muncul sekali per hari setelah masuk.
 * "Nanti saja" menunda sampai besok; "Isi Gmail sekarang" membuka form email di Profil.
 */
export function EmailReminder() {
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (path.startsWith("/profil")) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(KEY);
    } catch {}
    if (seen === todayStr()) return;
    ref.current?.showModal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = (then?: () => void) => {
    try {
      localStorage.setItem(KEY, todayStr());
    } catch {}
    setClosing(true);
    window.setTimeout(() => {
      ref.current?.close();
      setClosing(false);
      then?.();
    }, CLOSE_MS);
  };
  return (
    <dialog
      ref={ref}
      data-closing={closing || undefined}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="modal w-[calc(100%-1.5rem)] max-w-md rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50"
      aria-labelledby="email-reminder-title"
    >
      <div className="space-y-3 p-5">
        <h2 id="email-reminder-title" className="text-lg font-semibold text-slate-900">📧 Gmail Anda belum diisi</h2>
        <p className="text-sm text-slate-600">Isi Gmail di akun Anda supaya:</p>
        <ul className="space-y-2 text-sm text-slate-700">
          <li>🔑 <b>Lupa password?</b> Bisa buat password baru sendiri lewat link yang dikirim ke Gmail, tanpa menunggu Owner.</li>
          <li>⚡ <b>Masuk lebih cepat</b> dengan tombol &quot;Masuk dengan Google&quot;, tanpa mengetik password.</li>
          <li>🔔 <b>Menerima pemberitahuan penting</b> dari Main Gypsum.</li>
        </ul>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={() => close()}>Nanti saja</button>
          <button type="button" className="btn-primary" onClick={() => close(() => router.push("/profil?isi=email"))} autoFocus>Isi Gmail sekarang</button>
        </div>
      </div>
    </dialog>
  );
}
