"use client";
import { useEffect, useState } from "react";

type Toast = { id: number; text: string; ok: boolean; leaving?: boolean };

/** Lama animasi keluar toast, samakan dengan .toast[data-leaving] di globals.css */
const LEAVE_MS = 220;

/** Notifikasi sukses global — tetap tampil walau form asal hilang setelah data diperbarui */
export function toast(text: string, ok = true) {
  window.dispatchEvent(new CustomEvent("mg-toast", { detail: { text, ok } }));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; ok: boolean }>).detail;
      const id = Date.now() + Math.random();
      // Maks. 3 toast sekaligus agar tidak menutupi layar HP
      setItems((x) => [...x.slice(-2), { id, ...d }]);
      setTimeout(() => setItems((x) => x.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 3800);
      setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 3800 + LEAVE_MS);
    };
    window.addEventListener("mg-toast", on);
    return () => window.removeEventListener("mg-toast", on);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 pb-[env(safe-area-inset-bottom)] lg:bottom-6" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          data-leaving={t.leaving || undefined}
          className={`toast pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg [overflow-wrap:anywhere] ${t.ok ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}`}
        >
          {t.ok ? (
            <svg viewBox="0 0 24 24" className="check-draw h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          ) : (
            <span aria-hidden>⚠️</span>
          )}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
