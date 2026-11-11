import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, fmtDay, todayStr } from "@/lib/time";
import { Card, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { BarsChart, TrendChart } from "@/components/Charts";
import { MONITOR_TEMPLATES, VARIANTS, monitorDaily, monitorSum, type WorkData } from "@/lib/shiftReport";

export const metadata = { title: "Monitoring Resi & Patung" };

const DIV_COLORS = ["#2563eb", "#f97316", "#16a34a", "#9333ea"];
const f = (v: number) => v.toLocaleString("id-ID");

/** Periode: bulan (YYYY-MM) atau 30 hari terakhir */
function range(month?: string) {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const start = `${month}-01`;
    const next = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10);
    const end = addDays(next, -1);
    const today = todayStr();
    return { start, end: end > today ? today : end, label: `Bulan ${month.slice(5, 7)}/${month.slice(0, 4)}` };
  }
  const end = todayStr();
  return { start: addDays(end, -29), end, label: "30 hari terakhir" };
}

export default async function MonitoringPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const user = await requirePerm("report.view");
  const sp = await searchParams;
  const { start, end, label } = range(sp.bulan);
  const fixedDivision = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" ? user.divisionId : null;
  const divisions = await prisma.division.findMany({ where: { reportTemplate: { in: MONITOR_TEMPLATES }, ...(fixedDivision ? { id: fixedDivision } : {}) }, orderBy: { code: "asc" } });
  const reports = await prisma.shiftReport.findMany({
    where: { date: { gte: dateOnly(start), lte: dateOnly(end) }, status: { in: ["TERKIRIM", "DIREVISI"] }, divisionId: { in: divisions.map((d) => d.id) } },
    include: { division: true },
    orderBy: { date: "asc" },
  });
  const names = divisions.map((d) => d.name);
  const days = monitorDaily(reports.map((r) => ({ date: r.date, division: r.division.name, template: r.division.reportTemplate, work: r.work as WorkData })), start, end, names);
  const sum = monitorSum(days);
  const withData = days.filter((d) => d.total.resi || d.total.patung).length;
  const avg = (v: number) => (withData ? Math.round(v / withData) : 0);
  const dl = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const resiChart = days.map((d) => ({ label: dl(d.date), shopee: d.total.shopee, tiktok: d.total.tiktok, total: d.total.resi }));
  const divKey = (i: number) => `d${i}`;
  const patungChart = days.map((d) => ({ label: dl(d.date), ...Object.fromEntries(names.map((n, i) => [divKey(i), d.byDivision[n]?.patung ?? 0])) }));
  const csv = [
    [`Monitoring resi & patung ${start} s/d ${end}`],
    [],
    ["Tanggal", "Resi Shopee", "Resi TikTok", "Total resi", ...names.map((n) => `Resi ${n}`), ...names.map((n) => `Patung ${n}`), "Total patung", ...VARIANTS.map((v) => `Patung ${v}`)],
    ...days.map((d) => [d.date, d.total.shopee, d.total.tiktok, d.total.resi, ...names.map((n) => d.byDivision[n]?.resi ?? 0), ...names.map((n) => d.byDivision[n]?.patung ?? 0), d.total.patung, ...VARIANTS.map((v) => d.total.byVariant[v] ?? 0)]),
    ["Total", sum.total.shopee, sum.total.tiktok, sum.total.resi, ...names.map((n) => sum.byDivision[n]?.resi ?? 0), ...names.map((n) => sum.byDivision[n]?.patung ?? 0), sum.total.patung, ...VARIANTS.map((v) => sum.total.byVariant[v] ?? 0)],
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring resi & patung"
        subtitle={`Dari laporan shift ${names.join(" + ") || "Packing + Giftbox"} yang sudah dikirim · ${label}`}
        actions={<><Link href="/laporan/rekap" className="btn-secondary">Rekap produksi</Link><DownloadCsv filename={`monitoring-resi-patung-${start}`} rows={csv} /></>}
      />
      <FilterBar>
        <Field label="Bulan" hint="Kosong = 30 hari terakhir"><input type="month" name="bulan" defaultValue={sp.bulan ?? ""} className="input" /></Field>
      </FilterBar>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total resi" value={f(sum.total.resi)} hint={`Shopee ${f(sum.total.shopee)} · TikTok ${f(sum.total.tiktok)}`} />
        <Stat label="Rata-rata resi / hari" value={f(avg(sum.total.resi))} hint={`${withData} hari ada laporan`} />
        <Stat label="Total patung keluar" value={f(sum.total.patung)} hint={names.map((n) => `${n} ${f(sum.byDivision[n]?.patung ?? 0)}`).join(" · ")} tone="blue" />
        <Stat label="Rata-rata patung / hari" value={f(avg(sum.total.patung))} hint={sum.total.resi ? `±${(sum.total.patung / sum.total.resi).toLocaleString("id-ID", { maximumFractionDigits: 1 })} patung per resi` : undefined} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Resi harian (jumlah order marketplace)" className="min-w-0">
          <TrendChart data={resiChart} series={[{ key: "shopee", label: "Shopee", color: "#f97316" }, { key: "tiktok", label: "TikTok", color: "#0f172a" }, { key: "total", label: "Total", color: "#2563eb" }]} />
        </Card>
        <Card title="Patung keluar harian per divisi" className="min-w-0">
          <BarsChart data={patungChart} series={names.map((n, i) => ({ key: divKey(i), label: n, color: DIV_COLORS[i % DIV_COLORS.length] }))} />
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Kontribusi per divisi" className="min-w-0">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Divisi</th><th className="num">Shopee</th><th className="num">TikTok</th><th className="num">Total resi</th><th className="num">Patung</th><th className="num">% patung</th></tr></thead>
              <tbody>
                {names.map((n) => {
                  const m = sum.byDivision[n];
                  return <tr key={n}><td>{n}</td><td className="num">{f(m?.shopee ?? 0)}</td><td className="num">{f(m?.tiktok ?? 0)}</td><td className="num">{f(m?.resi ?? 0)}</td><td className="num">{f(m?.patung ?? 0)}</td><td className="num">{sum.total.patung ? `${Math.round(((m?.patung ?? 0) / sum.total.patung) * 100)}%` : "—"}</td></tr>;
                })}
              </tbody>
              <tfoot><tr className="font-semibold"><td>Total</td><td className="num">{f(sum.total.shopee)}</td><td className="num">{f(sum.total.tiktok)}</td><td className="num">{f(sum.total.resi)}</td><td className="num">{f(sum.total.patung)}</td><td /></tr></tfoot>
            </table>
          </div>
        </Card>
        <Card title="Patung keluar per karakter" className="min-w-0">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Karakter</th>{names.map((n) => <th key={n} className="num">{n}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {VARIANTS.map((v) => <tr key={v}><td>{v}</td>{names.map((n) => <td key={n} className="num">{f(sum.byDivision[n]?.byVariant[v] ?? 0)}</td>)}<td className="num font-semibold">{f(sum.total.byVariant[v] ?? 0)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">Paket/giftbox Mix dibagi rata ke 4 karakter.</p>
        </Card>
      </div>
      <Card title="Rincian harian" className="min-w-0">
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Tanggal</th><th className="num">Shopee</th><th className="num">TikTok</th><th className="num">Total resi</th>{names.map((n) => <th key={n} className="num">Patung {n}</th>)}<th className="num">Total patung</th></tr></thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.date} className={d.total.resi || d.total.patung ? "" : "text-slate-400"}>
                  <td className="whitespace-nowrap">{fmtDay(dateOnly(d.date))}</td><td className="num">{f(d.total.shopee)}</td><td className="num">{f(d.total.tiktok)}</td><td className="num font-medium">{f(d.total.resi)}</td>
                  {names.map((n) => <td key={n} className="num">{f(d.byDivision[n]?.patung ?? 0)}</td>)}
                  <td className="num font-semibold">{f(d.total.patung)}</td>
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      </Card>
    </div>
  );
}
