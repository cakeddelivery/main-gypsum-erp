import { requirePerm } from "@/lib/auth";
import { balanceSheet } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDay, dateOnly } from "@/lib/time";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { BackLink, parseRange, ReportFilter, Section, storeLabel, type SP } from "../shared";

export const metadata = { title: "Neraca" };

export default async function Neraca({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const bs = await balanceSheet(r.end, r.storeId);
  return (
    <div>
      <PageHeader title="Neraca" actions={<><BackLink /><DownloadJpg targetId="nr" filename={`neraca-${r.to}`} /></>} />
      <ReportFilter sp={sp} showFrom={false} />
      <div id="nr" className="card p-6">
        <div className="mb-4 text-center"><div className="font-semibold">Neraca · {await storeLabel(r.storeId)}</div><div className="text-sm text-slate-500">Per {fmtDay(dateOnly(r.to))}</div></div>
        <div className="grid gap-6 md:grid-cols-2">
          <div><Section title="Aset" rows={bs.assets} total={bs.totalAssets} totalLabel="Total aset" /></div>
          <div>
            <Section title="Kewajiban" rows={bs.liabilities} total={bs.totalLiabilities} totalLabel="Total kewajiban" />
            <Section title="Ekuitas" rows={[...bs.equity, { code: "—", name: "Laba (rugi) berjalan", amount: bs.currentEarnings }]} total={bs.totalEquity} totalLabel="Total ekuitas" />
            <div className="flex justify-between border-t pt-2 font-semibold"><span>Total kewajiban + ekuitas</span><span className="tabular-nums">{idr(bs.totalLiabilities + bs.totalEquity)}</span></div>
          </div>
        </div>
        <p className={`mt-4 text-center text-sm font-medium ${bs.balanced ? "text-emerald-600" : "text-rose-600"}`}>{bs.balanced ? "✓ Neraca seimbang" : "✗ Neraca tidak seimbang — periksa jurnal"}</p>
      </div>
    </div>
  );
}
