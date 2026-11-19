"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { kind: "MASUK" | "LAPORAN"; key: string; title: string; body: string; url: string };
const STORE = "mg_ingat_ditutup";

function dismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "[]");
  } catch {
    return [];
  }
}

/** Popup pengingat absen masuk / kirim laporan saat aplikasi dibuka (dicek tiap menit & saat kembali ke aplikasi) */
export function ReminderPopup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [item, setItem] = useState<Item | null>(null);
  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/pengingat", { cache: "no-store" });
      if (!r.ok) return;
      const { items } = (await r.json()) as { items: Item[] };
      const closed = dismissed();
      setItem(items.find((i) => !closed.includes(i.key)) ?? null);
    } catch {
      /* offline: coba lagi nanti */
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void check();
    const t = setInterval(check, 60_000);
    const vis = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [enabled, check]);
  if (!item) return null;
  const close = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify([...dismissed(), item.key].slice(-30)));
    } catch {
      /* penyimpanan tidak tersedia: tutup saja */
    }
    setItem(null);
  };
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="ingat-judul" className="fixed inset-0 z-[80] grid place-items-center bg-slate-900/50 p-4">
      <div className="card w-full max-w-sm space-y-3 p-5 text-center">
        <div className="text-4xl" aria-hidden>{item.kind === "MASUK" ? "⏰" : "📝"}</div>
        <h2 id="ingat-judul" className="text-lg font-extrabold text-slate-900">{item.title}</h2>
        <p className="text-slate-700">{item.body}</p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={close}>Nanti</button>
          <button type="button" className="btn-primary flex-1" onClick={() => { close(); router.push(item.url); }}>{item.kind === "MASUK" ? "Absen sekarang" : "Buka laporan"}</button>
        </div>
      </div>
    </div>
  );
}
