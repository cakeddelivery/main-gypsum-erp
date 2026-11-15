"use client";
import { useEffect, useRef } from "react";
import { toast } from "./Toaster";

type Saved = { at: number; v: Record<string, string | boolean> };
const MAX_AGE = 3 * 24 * 3600 * 1000;

const fields = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input[name], select[name], textarea[name]")).filter(
    (el) => !(el instanceof HTMLInputElement && ["file", "hidden", "submit", "button", "reset", "image", "password"].includes(el.type)),
  );
const keyOf = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) =>
  el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? `${el.name}::${el.value}` : el.name;

/** Hapus draf lokal (setelah tersimpan ke server / dibuang) */
export function clearFormDraft(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {}
}

/** Isi nilai seperti diketik pengguna agar komponen React (terkontrol) ikut berubah */
function setNative(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Simpan isian form ke HP (localStorage) setiap kali diketik, dan pulihkan otomatis saat form dibuka lagi.
 * Mencegah isian hilang bila halaman dimuat ulang sendiri, mis. HP menutup browser di latar belakang saat kamera
 * dibuka untuk foto checklist. Draf dihapus setelah tersimpan/terkirim ke server (clearFormDraft).
 */
export function FormDraft({ storageKey, target }: { storageKey: string; target: React.RefObject<HTMLElement | null> }) {
  const restored = useRef(false);
  useEffect(() => {
    const root = target.current;
    if (!root) return;
    // Pulihkan sekali saat form muncul. Ditunda sebentar (form & komponen terkontrol harus sudah siap),
    // lalu dicek ulang: kolom yang tertimpa render awal diisi lagi.
    const timers: number[] = [];
    if (!restored.current) {
      let saved: Saved | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      } catch {}
      if (saved && Date.now() - saved.at < MAX_AGE) {
        const data = saved.v;
        const apply = () => {
          let n = 0;
          for (const el of fields(root)) {
            const v = data[keyOf(el)];
            if (v === undefined) continue;
            if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
              if (el.checked !== v) {
                el.click();
                n++;
              }
            } else if (el.value !== v) {
              setNative(el, String(v));
              n++;
            }
          }
          return n;
        };
        timers.push(window.setTimeout(() => {
          restored.current = true;
          const n = apply();
          if (n) toast(`Isian yang belum tersimpan dipulihkan (${n} kolom)`);
          timers.push(window.setTimeout(apply, 400));
        }, 120));
      } else {
        restored.current = true;
        if (saved) clearFormDraft(storageKey);
      }
    }
    let t = 0;
    const save = () => {
      window.clearTimeout(t);
      const v: Saved["v"] = {};
      for (const el of fields(root)) {
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) v[keyOf(el)] = el.checked;
        else v[keyOf(el)] = el.value;
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), v } satisfies Saved));
      } catch {}
    };
    const later = () => {
      window.clearTimeout(t);
      t = window.setTimeout(save, 300);
    };
    // Simpan segera saat aplikasi ke latar belakang (mis. kamera terbuka) dan sebelum tombol foto membuka kamera
    const flush = () => document.visibilityState === "hidden" && save();
    const onPointer = (e: Event) => (e.target as HTMLElement).closest("[data-flush-draft]") && save();
    root.addEventListener("input", later);
    root.addEventListener("change", later);
    root.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", save);
    return () => {
      timers.forEach((x) => window.clearTimeout(x));
      window.clearTimeout(t);
      root.removeEventListener("input", later);
      root.removeEventListener("change", later);
      root.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", save);
    };
  }, [storageKey, target]);
  return null;
}
