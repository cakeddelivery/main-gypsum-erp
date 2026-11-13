"use client";
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Halaman daftar yang datanya sering berubah oleh orang lain: disegarkan berkala selama terbuka */
const LIVE = ["/", "/laporan", "/finance", "/stok", "/produksi", "/penjualan", "/absensi"];
const EVERY_MS = 45_000;
/** Kembali ke aplikasi setelah ditinggal sekian lama → data disegarkan */
const AWAY_MS = 20_000;

/** Jangan menyegarkan saat orang sedang mengisi form / membuka popup */
function busy() {
  if (document.querySelector("dialog[open]")) return true;
  const a = document.activeElement;
  return !!a && a.matches("input, textarea, select, [contenteditable]");
}

/**
 * "Realtime" ringan tanpa layanan tambahan di server: data halaman diambil ulang otomatis
 * (router.refresh, tanpa memuat ulang halaman & tanpa kehilangan isian) saat aplikasi dibuka kembali,
 * dan tiap 45 detik di halaman daftar penting. Hemat RAM VPS dibanding koneksi terus-menerus.
 */
export function AutoRefresh() {
  const router = useRouter();
  const path = usePathname();
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") return void (hiddenAt.current = Date.now());
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (away >= AWAY_MS && !busy()) router.refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [router]);

  useEffect(() => {
    if (!LIVE.includes(path)) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false && !busy()) router.refresh();
    }, EVERY_MS);
    return () => window.clearInterval(id);
  }, [path, router]);

  return null;
}
