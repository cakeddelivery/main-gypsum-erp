import { requirePerm } from "@/lib/auth";
import { profitLoss } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDay, dateOnly } from "@/lib/time";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { BackLink, parseRange, ReportFilter, Section, storeLabel, type SP } from "../shared";

export const metadata = { title: "Laba Rugi" };

export default async function LabaRugi({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const pl = await profitLoss({ start: r.start, end: r.end, storeId: r.storeId });
  return (
    <div>
      <PageHeader title="Laporan laba rugi" actions={<><BackLink /><DownloadJpg targetId="lr" filename={`laba-rugi-${r.from}-${r.to}`} /></>} />
      <ReportFilter sp={sp} />
      <div id="lr" className="card mx-auto max-w-2xl p-6">
        <div className="mb-4 text-center"><div className="font-semibold">Laba Rugi · {await storeLabel(r.storeId)}</div><div className="text-sm text-slate-500">{fmtDay(dateOnly(r.from))} – {fmtDay(dateOnly(r.to))}</div></div>
        <Section title="Pendapatan" rows={pl.revenue} total={pl.totalRevenue} totalLabel="Total pendapatan" />
        <Section title="Harga pokok penjualan" rows={pl.cogs} total={pl.totalCogs} totalLabel="Total HPP" />
        <div className="mb-4 flex justify-between border-y py-2 font-semibold"><span>Laba kotor</span><span className="tabular-nums">{idr(pl.grossProfit)}</span></div>
        <Section title="Beban operasional" rows={pl.expenses} total={pl.totalExpenses} totalLabel="Total beban" />
        <div className={`flex justify-between rounded-lg px-3 py-2 text-base font-bold ${pl.netProfit >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}><span>Laba (rugi) bersih</span><span className="tabular-nums">{idr(pl.netProfit)}</span></div>
      </div>
    </div>
  );
}
