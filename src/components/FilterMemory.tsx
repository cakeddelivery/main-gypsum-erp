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

/**
 * Mengingat filter daftar (per halaman, selama tab browser terbuka).
 * Kembali ke daftar lewat menu/tautan tanpa filter → filter terakhir dipulihkan.
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
      router.replace(`${path}?${saved}`);
      return;
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
