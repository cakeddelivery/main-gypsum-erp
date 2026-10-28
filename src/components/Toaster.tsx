"use client";
import { useEffect, useState } from "react";

type Toast = { id: number; text: string; ok: boolean };

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
      setItems((x) => [...x, { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4000);
    };
    window.addEventListener("mg-toast", on);
    return () => window.removeEventListener("mg-toast", on);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} role="status" className={`pointer-events-auto max-w-md rounded-lg px-4 py-2 text-sm font-medium shadow-lg ${t.ok ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}`}>
          {t.ok ? "✓ " : ""}{t.text}
        </div>
      ))}
    </div>
  );
}
