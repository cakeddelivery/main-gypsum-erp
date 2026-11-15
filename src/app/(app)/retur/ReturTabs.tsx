import Link from "next/link";
import type { Permission } from "@/lib/rbac";

/** Pindah antara Retur paket dan Komplain & Refund (satu menu) */
export function ReturTabs({ current, can }: { current: "retur" | "komplain"; can: (p: Permission) => boolean }) {
  const tabs = [
    ...(can("retur.manage") ? [{ key: "retur", label: "📦 Retur paket", href: "/retur" }] : []),
    ...(can("refund.request") || can("refund.approve") || can("refund.pay") ? [{ key: "komplain", label: "💬 Komplain & refund", href: "/retur/komplain" }] : []),
  ];
  if (tabs.length < 2) return null;
  return (
    <div className="flex gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
      {tabs.map((t) => <Link key={t.key} href={t.href} className={`flex-1 rounded-lg px-3 py-2 text-center ${t.key === current ? "bg-white text-brand-700 shadow-sm" : "text-slate-600"}`}>{t.label}</Link>)}
    </div>
  );
}
