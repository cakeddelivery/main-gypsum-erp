"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CURRENT_BUILD, RELOAD_KEY, canAutoReload, isBusy, isNewBuild, isStaleError } from "@/lib/appVersion";

const CHECK_EVERY_MS = 5 * 60_000;
const MIN_GAP_MS = 15_000;

/** Dipanggil error boundary bila error disebabkan versi lama (chunk hilang / server action berganti) */
export function reportStaleError() {
  window.dispatchEvent(new Event("mg-stale-error"));
}

/**
 * Pembaruan otomatis aplikasi terpasang (PWA) & tab yang lama terbuka.
 * Versi server dicek saat aplikasi dibuka lagi, tiap ±5 menit, dan saat muncul error versi lama.
 * Versi baru: langsung dimuat ulang bila tidak sedang mengisi apa pun; bila ada popup/isian,
 * tampil pemberitahuan dan dimuat ulang otomatis setelah popup ditutup (isian tidak dihapus).
 */
export function AppUpdater() {
  const [pending, setPending] = useState(false);
  const waiting = useRef(false);
  // Popup terbuka berada di "top layer" dan membuat sisa halaman tidak bisa diklik, jadi pemberitahuan
  // ditempel ke dalam popup paling atas agar terlihat dan tombolnya bisa ditekan
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    if (!pending) return;
    const pick = () => {
      const open = document.querySelectorAll("dialog[open]");
      setHost(open.length ? open[open.length - 1] : document.body);
    };
    pick();
    const t = window.setInterval(pick, 500);
    return () => window.clearInterval(t);
  }, [pending]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || CURRENT_BUILD === "dev") return;
    let lastCheck = 0;

    const reloadNow = () => {
      let last: string | null = null;
      try {
        last = sessionStorage.getItem(RELOAD_KEY);
      } catch {}
      // Sudah dimuat ulang otomatis kurang dari semenit lalu: jangan berulang, tawarkan tombol saja
      if (!canAutoReload(last, Date.now())) return setPending(true);
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {}
      window.location.reload();
    };
    const onNewVersion = () => {
      waiting.current = true;
      if (isBusy(document)) setPending(true);
      else reloadNow();
    };
    const check = async (force = false) => {
      if (waiting.current) return;
      const now = Date.now();
      if (!force && now - lastCheck < MIN_GAP_MS) return;
      lastCheck = now;
      navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
      try {
        const res = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (isNewBuild(CURRENT_BUILD, build)) onNewVersion();
      } catch {
        // offline / server sedang restart: coba lagi di pengecekan berikutnya
      }
    };
    const onStale = () => {
      waiting.current = true;
      if (isBusy(document)) setPending(true);
      else reloadNow();
    };

    const onVisible = () => document.visibilityState === "visible" && check();
    const onFocus = () => check();
    const onPageShow = (e: PageTransitionEvent) => check(e.persisted);
    const onOnline = () => check(true);
    const onError = (e: ErrorEvent) => isStaleError(e.error ?? e.message) && onStale();
    const onRejection = (e: PromiseRejectionEvent) => isStaleError(e.reason) && onStale();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("mg-stale-error", onStale);
    const every = window.setInterval(() => document.visibilityState === "visible" && check(), CHECK_EVERY_MS);
    // Menunggu popup/isian selesai: muat ulang begitu pengguna tidak sedang mengisi
    const idle = window.setInterval(() => waiting.current && !isBusy(document) && reloadNow(), 2000);
    check(true);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("mg-stale-error", onStale);
      window.clearInterval(every);
      window.clearInterval(idle);
    };
  }, []);

  if (!pending || !host) return null;
  return createPortal(
    <div role="status" aria-live="polite" className="no-print fixed inset-x-3 bottom-24 z-[65] mx-auto flex max-w-md items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl ring-1 ring-white/10 sm:bottom-4">
      <span className="min-w-0 flex-1">Versi baru tersedia. Isian Anda aman; aplikasi dimuat ulang setelah popup ditutup.</span>
      <button type="button" className="min-h-9 shrink-0 rounded-lg bg-white px-3 py-1.5 font-semibold text-slate-900" onClick={() => window.location.reload()}>
        Muat ulang
      </button>
    </div>,
    host,
  );
}
