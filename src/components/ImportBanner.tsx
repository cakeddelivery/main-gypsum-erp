"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { importRunningAction } from "@/app/(app)/penjualan/marketplace/actions";

type Running = { by: string; total: number; done: number; label: string | null } | null;

/** Banner "Impor sedang diproses…" — angka di halaman ini bisa belum final. Memeriksa tiap 5 detik; muat ulang halaman saat selesai. */
export function ImportBanner({ initial }: { initial: Running }) {
  const [run, setRun] = useState<Running>(initial);
  const router = useRouter();
  useEffect(() => {
    if (!run) return;
    const t = setInterval(async () => {
      const r = await importRunningAction().catch(() => null);
      if (r === null) return;
      setRun(r.running);
      if (!r.running) router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [run, router]);
  if (!run) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <b>Impor sedang diproses…</b> {run.by} sedang mengunggah ({run.done}/{run.total} file{run.label ? ` · ${run.label}` : ""}). Angka di halaman ini belum final sampai selesai.
    </div>
  );
}
