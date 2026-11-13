"use client";
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Hapus parameter sekali-pakai dari alamat (mis. ?isi=1 yang membuka popup) agar muat ulang halaman tidak membukanya lagi */
export function ClearQuery({ param }: { param: string }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  useEffect(() => {
    if (!sp.has(param)) return;
    const next = new URLSearchParams(sp);
    next.delete(param);
    const q = next.toString();
    router.replace(q ? `${path}?${q}` : path, { scroll: false });
  }, [param, path, router, sp]);
  return null;
}
