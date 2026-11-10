"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Parameter yang bukan filter (membuka popup, pesan sekali tampil, dll.) tidak ikut diingat */
const IGNORED = new Set(["baru", "reset", "ok", "err", "msg"]);
const keyOf = (path: string) => `filter:${path}`;

function filterQuery(sp: URLSearchParams) {
  const out = new URLSearchParams();
  sp.forEach((v, k) => {
    if (!IGNORED.has(k) && v !== "") out.append(k, v);
  });
  return out.toString();
}

function read(path: string) {
  try {
    return sessionStorage.getItem(keyOf(path));
  } catch {
    return null;
  }
}
function write(path: string, q: string | null) {
  try {
    if (q) sessionStorage.setItem(keyOf(path), q);
    else sessionStorage.removeItem(keyOf(path));
  } catch {
    /* penyimpanan browser tidak tersedia: filter tidak diingat, halaman tetap jalan */
  }
}

const CUR = "nav:cur";
const PREV = "nav:prev";
function ss(k: string) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
const pathOf = (u: string | null) => (u ?? "").split("?")[0];
/**
 * Pathname halaman asal. "nav:cur"/"nav:prev" menyimpan path + query, sehingga hasilnya sama
 * entah NavTracker sudah atau belum mencatat halaman ini.
 */
function cameFrom(here: string) {
  const cur = ss(CUR);
  return cur === here ? pathOf(ss(PREV)) : pathOf(cur);
}

/**
 * Mencatat perpindahan halaman (dipasang sekali di Shell): setiap pathname ATAU query berubah,
 * "nav:prev" = halaman sebelumnya, "nav:cur" = halaman sekarang. Klik tab di halaman yang sama
 * membuat prev = cur = halaman ini, jadi FilterMemory tahu itu bukan "kembali dari halaman lain".
 */
export function NavTracker() {
  const path = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  useEffect(() => {
    try {
      const cur = sessionStorage.getItem(CUR);
      if (cur !== null) sessionStorage.setItem(PREV, cur);
      sessionStorage.setItem(CUR, qs ? `${path}?${qs}` : path);
    } catch {
      /* abaikan */
    }
  }, [path, qs]);
  return null;
}

/**
 * Mengingat filter daftar (per halaman, selama tab browser terbuka).
 * Kembali ke daftar DARI HALAMAN LAIN (detail, menu bawah) tanpa filter → filter terakhir dipulihkan.
 * Membuka tautan tanpa filter dari halaman yang sama (mis. tab "Semua") = filter sengaja dikosongkan.
 * Tombol "Reset" menghapus filter yang diingat.
 */
export function FilterMemory() {
  const path = usePathname();
  const sp = useSearchParams();
  const router = useRouter();
  const q = filterQuery(new URLSearchParams(sp.toString()));
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (sp.get("reset") === "1") {
      write(path, null);
      router.replace(path);
      return;
    }
    if (q) {
      write(path, q);
      setActive(true);
      return;
    }
    const saved = read(path);
    if (saved && !sp.toString()) {
      const here = sp.toString() ? `${path}?${sp.toString()}` : path;
      if (cameFrom(here) !== path) {
        router.replace(`${path}?${saved}`);
        return;
      }
      write(path, null);
    }
    setActive(false);
  }, [path, q, sp, router]);

  if (!active) return null;
  return (
    <a href={`${path}?reset=1`} className="btn-secondary col-span-2 text-center sm:col-span-1">
      Reset filter
    </a>
  );
}
