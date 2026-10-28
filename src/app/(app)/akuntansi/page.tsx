import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { profitLoss, balanceSheet } from "@/lib/accounting";
import { bankBalances } from "@/lib/finance";
import { inventoryValuation } from "@/lib/stock";
import { idr } from "@/lib/money";
import { PageHeader, Stat } from "@/components/ui";
import { parseRange, REPORTS } from "./shared";

export const metadata = { title: "Akuntansi" };

export default async function AkuntansiPage() {
  await requirePerm("accounting.view");
  const r = parseRange({});
  const [pl, bs, banks, inv] = await Promise.all([profitLoss({ start: r.start, end: r.end }), balanceSheet(r.end), bankBalances(), inventoryValuation()]);
  return (
    <div>
      <PageHeader title="Akuntansi & pembukuan" subtitle="Double-entry · satu organisasi, toko Main Gypsum & Dunia Lukis (laporan terpisah & konsolidasi)" />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Laba bersih bulan ini" value={idr(pl.netProfit)} tone={pl.netProfit >= 0 ? "green" : "red"} href="/akuntansi/laba-rugi" />
        <Stat label="Total aset" value={idr(bs.totalAssets)} href="/akuntansi/neraca" hint={bs.balanced ? "Neraca seimbang ✓" : "Neraca TIDAK seimbang"} tone={bs.balanced ? "slate" : "red"} />
        <Stat label="Kas & bank" value={idr(banks.reduce((s, b) => s + b.balance, 0))} href="/akuntansi/buku-besar" />
        <Stat label="Nilai persediaan (stok)" value={idr(inv.total)} href="/stok/kartu" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((x) => (
          <Link key={x.href} href={x.href} className="card p-4 transition hover:border-brand-300 hover:bg-brand-50/40">
            <div className="font-medium text-slate-800">{x.label}</div>
            <div className="text-sm text-slate-500">{x.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
