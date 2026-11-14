"use client";
import { useEffect } from "react";
import { reportStaleError } from "@/components/AppUpdater";
import { isStaleError } from "@/lib/appVersion";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleError(error);
  // Error karena aplikasi di HP masih versi lama setelah update: muat ulang sekali ke versi baru
  useEffect(() => {
    if (stale) reportStaleError();
  }, [stale]);
  if (stale) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center">
        <h2 className="text-lg font-semibold text-slate-800">Aplikasi baru saja diperbarui</h2>
        <p className="mt-2 text-sm text-slate-600">Memuat versi terbaru…</p>
        <button className="btn-primary mt-4" onClick={() => window.location.reload()}>
          Muat ulang
        </button>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center">
      <h2 className="text-lg font-semibold text-rose-700">Terjadi kesalahan</h2>
      <p className="mt-2 text-sm text-slate-600">Halaman tidak dapat dimuat. {error.digest && <span className="text-xs text-slate-400">Kode: {error.digest}</span>}</p>
      <button className="btn-primary mt-4" onClick={reset}>
        Coba lagi
      </button>
    </div>
  );
}
