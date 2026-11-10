"use client";
import { useEffect, useState } from "react";

/** Event bawaan Chrome/Edge sebelum menampilkan tawaran instal (belum ada di tipe DOM standar) */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type PwaWindow = Window & { __mgInstall?: InstallEvent | null };

const CHANGE = "mg-install-change";

/** Pasang di root layout: daftarkan service worker (hanya build produksi/staging) dan simpan event instal */
export function PwaRegister() {
  useEffect(() => {
    const w = window as PwaWindow;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      w.__mgInstall = e as InstallEvent;
      window.dispatchEvent(new Event(CHANGE));
    };
    const onInstalled = () => {
      w.__mgInstall = null;
      window.dispatchEvent(new Event(CHANGE));
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone/iPad yang membuka ERP dari ikon layar utama: unduhan file lebih aman lewat menu Bagikan */
export function isIosStandalone() {
  return typeof window !== "undefined" && isIos() && isStandalone();
}

function isIos() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** Kartu "Pasang aplikasi" di Profil. Tersembunyi bila sudah dibuka sebagai aplikasi terpasang. */
export function InstallAppCard() {
  const [state, setState] = useState<{ ready: boolean; standalone: boolean; ios: boolean; canPrompt: boolean }>({ ready: false, standalone: false, ios: false, canPrompt: false });
  const [done, setDone] = useState(false);

  useEffect(() => {
    const read = () => setState({ ready: true, standalone: isStandalone(), ios: isIos(), canPrompt: !!(window as PwaWindow).__mgInstall });
    read();
    window.addEventListener(CHANGE, read);
    return () => window.removeEventListener(CHANGE, read);
  }, []);

  if (!state.ready || state.standalone) return null;

  const install = async () => {
    const w = window as PwaWindow;
    const ev = w.__mgInstall;
    if (!ev) return;
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    w.__mgInstall = null;
    if (outcome === "accepted") setDone(true);
    window.dispatchEvent(new Event(CHANGE));
  };

  return (
    <section className="card" aria-labelledby="pasang-app">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 id="pasang-app" className="text-sm font-semibold text-slate-700">Pasang aplikasi</h2>
      </div>
      <div className="space-y-3 p-4 text-sm text-slate-700">
        <p>Pasang ERP di layar utama HP agar bisa dibuka seperti aplikasi biasa, tanpa mengetik alamat.</p>
        {done ? (
          <p className="rounded-lg bg-emerald-50 p-2 text-emerald-700">Aplikasi sedang dipasang. Cari ikon &quot;MG ERP&quot; di layar utama.</p>
        ) : state.ios ? (
          <ol className="list-decimal space-y-1 pl-5">
            <li>Buka halaman ini di <b>Safari</b>.</li>
            <li>Ketuk tombol <b>Bagikan</b> (kotak dengan panah ke atas) di bawah layar.</li>
            <li>Gulir lalu pilih <b>Tambah ke Layar Utama</b>, lalu ketuk <b>Tambah</b>.</li>
          </ol>
        ) : state.canPrompt ? (
          <button type="button" className="btn-primary w-full sm:w-auto" onClick={install}>Pasang aplikasi</button>
        ) : (
          <p className="text-slate-600">Di Chrome: ketuk menu <b>⋮</b> (titik tiga) lalu pilih <b>Instal aplikasi</b> atau <b>Tambahkan ke layar utama</b>. Bila pilihan itu tidak ada, aplikasi mungkin sudah terpasang.</p>
        )}
      </div>
    </section>
  );
}
