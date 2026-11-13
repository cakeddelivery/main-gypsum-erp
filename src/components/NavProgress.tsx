"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

const EVT = "nav-progress:start";

/** Mulai bilah progres secara manual, mis. sebelum router.push() */
export function startNavProgress() {
  window.dispatchEvent(new Event(EVT));
}

/** Klik tautan internal yang memang akan berpindah halaman (bukan tab baru, unduhan, atau #anchor) */
function isNavClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return false;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return false;
  return url.pathname !== location.pathname || url.search !== location.search;
}

/**
 * Bilah progres tipis di atas layar sejak tautan/menu diklik sampai halaman baru tampil,
 * agar selalu ada tanda bahwa klik sudah diterima walau server masih menyiapkan data.
 */
export function NavProgress() {
  const path = usePathname();
  const search = useSearchParams().toString();
  // Status bilah diubah langsung di DOM (bukan state React): setState tepat saat klik ikut tertahan
  // bersama transisi navigasi Next dan pernah membuat pindah tab tertunda 15 detik
  const bar = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const set = (s: "idle" | "loading" | "done") => bar.current?.setAttribute("data-state", s);

  useEffect(() => {
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    const start = () => {
      clear();
      set("loading");
      // Jaga-jaga bila navigasi batal (mis. dialihkan ke URL yang sama)
      timers.current.push(window.setTimeout(() => set("idle"), 15000));
    };
    const onClick = (e: MouseEvent) => isNavClick(e) && start();
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement;
      if (!e.defaultPrevented && f.getAttribute("method")?.toLowerCase() === "get") start();
    };
    // Fase capture: next/link memanggil preventDefault() di handler-nya sendiri
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    window.addEventListener(EVT, start);
    return () => {
      clear();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener(EVT, start);
    };
  }, []);

  // Halaman (atau tab) baru sudah tampil → bilah penuh lalu memudar
  useEffect(() => {
    if (bar.current?.getAttribute("data-state") !== "loading") return;
    timers.current.forEach(clearTimeout);
    set("done");
    const t = window.setTimeout(() => set("idle"), 400);
    return () => clearTimeout(t);
  }, [path, search]);

  return <div ref={bar} aria-hidden className="nav-progress no-print" data-state="idle" />;
}
