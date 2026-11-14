"use client";
import { useEffect } from "react";

/** Bilah atas halaman cetak (tidak ikut tercetak): tombol Cetak/Simpan PDF; ?print=1 membuka dialog cetak otomatis */
export function PrintBar({ auto, title }: { auto: boolean; title: string }) {
  useEffect(() => {
    if (!auto) return;
    // Tunggu gambar (logo & gambar layar) selesai dimuat agar ikut tercetak
    const imgs = Array.from(document.images);
    Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))).then(() => setTimeout(() => window.print(), 300));
  }, [auto]);
  return (
    <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 text-slate-800">
      <span className="min-w-0 flex-1 font-semibold">{title}</span>
      <span className="hidden text-sm text-slate-500 sm:inline">Pilih tujuan &quot;Simpan sebagai PDF&quot; untuk mengunduh.</span>
      <button type="button" className="btn-primary" onClick={() => window.print()}>📄 Cetak / Simpan PDF</button>
      <button type="button" className="btn-secondary" onClick={() => history.length > 1 ? history.back() : window.close()}>Tutup</button>
    </div>
  );
}
