import Link from "next/link";

const TABS = [
  { href: "/penjualan", label: "Dashboard", key: "dashboard" },
  { href: "/penjualan/marketplace", label: "Pesanan", key: "pesanan" },
  { href: "/penjualan/marketplace/impor", label: "Impor", key: "impor" },
  { href: "/penjualan/marketplace/sku", label: "Pemetaan SKU", key: "sku" },
  { href: "/penjualan/marketplace/potongan", label: "Potongan", key: "potongan" },
  { href: "/penjualan/marketplace/pengeluaran", label: "Pengeluaran", key: "pengeluaran" },
  { href: "/penjualan/marketplace/affiliate", label: "Affiliate", key: "affiliate" },
  { href: "/penjualan/marketplace/saldo", label: "Saldo", key: "saldo" },
  { href: "/penjualan/marketplace/rekon", label: "Rekonsiliasi", key: "rekon" },
  { href: "/penjualan/marketplace/wilayah", label: "Wilayah", key: "wilayah" },
];

/** Menu antar halaman Marketplace (geser ke samping di HP) */
export function MpNav({ current }: { current: string }) {
  return (
    <div className="no-print -mx-1 mb-4 flex gap-1 overflow-x-auto pb-1">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${t.key === current ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
