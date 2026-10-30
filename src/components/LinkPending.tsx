"use client";
import { useLinkStatus } from "next/link";

/** Pemutar kecil di dalam <Link> yang tampil selama halaman tujuan masih dimuat */
export function LinkPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  return pending ? <span aria-hidden className={`link-pending ${className}`} /> : null;
}
