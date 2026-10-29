import { requirePerm } from "@/lib/auth";
import { cashFlow } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDay, dateOnly } from "@/lib/time";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { parseRange, ReportFilter, storeLabel, type SP } from "../shared";

export const metadata = { title: "Arus Kas" };
const LABEL = { OPERASI: "Aktivitas operasi", INVESTASI: "Aktivitas investasi", PENDANAAN: "Aktivitas pendanaan" } as const;

export default async function ArusKas({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const cf = await cashFlow({ start: r.start, end: r.end, storeId: r.storeId });
  const net = cf.operating + cf.investing + cf.financing;
  return (
    <div>
      <PageHeader title="Laporan arus kas" subtitle="Metode langsung; transfer antar rekening tidak dihitung" actions={<><DownloadJpg targetId="ak" filename={`arus-kas-${r.from}-${r.to}`} /></>} />
      <ReportFilter sp={sp} />
      <div id="ak" className="card mx-auto max-w-2xl p-6 text-sm">
        <div className="mb-4 text-center"><div className="font-semibold">Arus Kas · {await storeLabel(r.storeId)}</div><div className="text-slate-500">{fmtDay(dateOnly(r.from))} – {fmtDay(dateOnly(r.to))}</div></div>
        <div className="mb-3 flex justify-between"><span>Saldo kas awal</span><span className="tabular-nums">{idr(cf.opening)}</span></div>
        {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (
          <div key={k} className="mb-4">
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">{LABEL[k]}</div>
            {cf.groups[k].length === 0 && <div className="text-slate-400">—</div>}
            {cf.groups[k].slice(0, 100).map((x, i) => <div key={i} className="flex justify-between border-b border-slate-100 py-0.5"><span className="truncate pr-3">{x.description}</span><span className={`tabular-nums ${x.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}>{idr(x.amount)}</span></div>)}
            <div className="flex justify-between pt-1 font-semibold"><span>Kas bersih {LABEL[k].toLowerCase()}</span><span className="tabular-nums">{idr(k === "OPERASI" ? cf.operating : k === "INVESTASI" ? cf.investing : cf.financing)}</span></div>
          </div>
        ))}
        <div className="flex justify-between border-t pt-2 font-semibold"><span>Kenaikan (penurunan) kas</span><span className="tabular-nums">{idr(net)}</span></div>
        <div className="flex justify-between font-bold"><span>Saldo kas akhir</span><span className="tabular-nums">{idr(cf.closing)}</span></div>
      </div>
    </div>
  );
}
