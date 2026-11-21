"use client";
import { Fragment } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Isian filter memakai defaultValue (tak terkendali): bila alamat berubah tanpa memuat ulang halaman (tautan, tombol kembali,
 * FilterMemory memulihkan filter), isian lama tertinggal — mis. URL ?toko=<id> tetapi kolom Toko masih "Semua".
 * Memberi key = query URL membuat isian dibuat ulang sehingga selalu sama dengan URL.
 */
export function FilterFields({ children }: { children: React.ReactNode }) {
  const sp = useSearchParams();
  return <Fragment key={sp.toString()}>{children}</Fragment>;
}
