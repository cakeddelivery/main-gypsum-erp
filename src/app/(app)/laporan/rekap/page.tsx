import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { reportDivision } from "@/lib/reportScope";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, fmtDay, todayStr } from "@/lib/time";
import { Paged } from "@/components/Paged";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Card, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DownloadCsv } from "@/components/DownloadCsv";
import { DocExport, DocSheet, DocSummary, DocTable, fmtRange } from "@/components/DocSheet";
import { letterhead } from "@/lib/letterhead";
import { metricText, personRecap, recapByDivision, recapLine, type RecapInput, type WorkData } from "@/lib/shiftReport";

export const metadata = { title: "Rekap Produksi" };

function range(period: string, date: string) {
  if (period === "mingguan") {
    const d = dateOnly(date);
    const dow = (d.getUTCDay() + 6) % 7; // Senin = 0
    const start = addDays(date, -dow);
    return { start, end: addDays(start, 6) };
  }
  if (period === "bulanan") {
    const start = date.slice(0, 8) + "01";
    const next = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 1));
    return { start, end: addDays(next.toISOString().slice(0, 10), -1) };
  }
  return { start: date, end: date };
}

export default async function RekapPage({ searchParams }: { searchParams: Promise<{ period?: string; date?: string; shift?: string }> }) {
  const user = await requirePerm("report.view");
  // Rekap & monitoring khusus pengelola (Owner/Admin/Supervisor/…); anggota divisi ditolak di server
  if (reportDivision(user) !== null) redirect("/forbidden");
  const sp = await searchParams;
  const period = ["harian", "mingguan", "bulanan"].includes(sp.period ?? "") ? sp.period! : "harian";
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayStr();
  const { start, end } = range(period, date);
  const fixedDivision = reportDivision(user);
  const where = { date: { gte: dateOnly(start), lte: dateOnly(end) }, ...(sp.shift ? { shiftId: sp.shift } : {}), ...(fixedDivision ? { divisionId: fixedDivision } : {}) };
  const [rows, divisions, shifts, reports] = await Promise.all([
    prisma.productionEntry.groupBy({ by: ["divisionId", "stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.division.findMany({ orderBy: { code: "asc" } }),
    prisma.shift.findMany({ orderBy: { code: "asc" } }),
    // Laporan shift yang sudah dikirim (draft belum dihitung)
    prisma.shiftReport.findMany({ where: { ...where, status: { in: ["TERKIRIM", "DIREVISI"] } }, include: { division: true, shift: true }, orderBy: [{ date: "asc" }, { division: { code: "asc" } }, { shift: { code: "asc" } }] }),
  ]);
  const recapRows: RecapInput[] = reports.map((r) => ({ date: r.date, shift: r.shift.name, division: r.division.name, template: r.division.reportTemplate, target: r.division.targetPerShift, work: r.work as WorkData }));
  const byDiv = recapByDivision(recapRows);
  const people = personRecap(recapRows);
  const daily = recapRows.map((r) => ({ ...r, ...recapLine(r) }));
  const pctCls = (p: number | null) => (p == null ? "" : p >= 100 ? "text-emerald-600" : "text-rose-600");
  const usedStages = STAGES.filter((s) => rows.some((r) => r.stage === s));
  const usedDivs = divisions.filter((d) => rows.some((r) => r.divisionId === d.id));
  const cell = (d: string, s: string) => rows.find((r) => r.divisionId === d && r.stage === s)?._sum;
  const totalGood = rows.reduce((t, r) => t + (r._sum.qtyGood ?? 0), 0);
  const totalReject = rows.reduce((t, r) => t + (r._sum.qtyReject ?? 0), 0);
  const shiftName = sp.shift ? shifts.find((s) => s.id === sp.shift)?.name : null;
  const lh = await letterhead();
  const qs = (p: string) => `/laporan/rekap?period=${p}&date=${date}${sp.shift ? `&shift=${sp.shift}` : ""}`;
  return (
    <div>
      <PageHeader title="Rekap produksi" subtitle="Laporan per shift, harian, mingguan, dan bulanan" actions={<><Link href="/laporan/monitoring" className="btn-secondary">Resi &amp; patung</Link><DownloadCsv filename={`rekap-${period}-${start}`} rows={[[`Rekap produksi ${start} s/d ${end}${shiftName ? ` (${shiftName})` : ""}`], [], ["Dari laporan shift"], ["Divisi", "Laporan", "Ringkasan", "Capaian target"], ...byDiv.map((d) => [d.division, d.reports, d.metrics.map(metricText).join(" · "), d.target ? `${d.target.pct}%` : ""]), [], ["Tanggal", "Divisi", "Shift", "Ringkasan", "Capaian target"], ...daily.map((r) => [r.date.toISOString().slice(0, 10), r.division, r.shift, r.text, r.pct == null ? "" : `${r.pct}%`]), [], ["Dari input Produksi"], ["Divisi", "Tahap", "Hasil baik (pcs)", "Reject (pcs)"], ...usedDivs.flatMap((d) => usedStages.filter((st) => cell(d.id, st)).map((st) => [d.name, STAGE_LABEL[st], cell(d.id, st)?.qtyGood ?? 0, cell(d.id, st)?.qtyReject ?? 0])), ["Total", "", totalGood, totalReject]]} /><DownloadJpg targetId="rekap" filename={`rekap-${period}-${start}`} /></>} />
      <Tabs current={period} tabs={[{ key: "harian", label: "Harian", href: qs("harian") }, { key: "mingguan", label: "Mingguan", href: qs("mingguan") }, { key: "bulanan", label: "Bulanan", href: qs("bulanan") }]} />
      <FilterBar>
        <input type="hidden" name="period" value={period} />
        <Field label="Tanggal acuan"><input type="date" name="date" defaultValue={date} className="input" /></Field>
        <Field label="Shift"><select name="shift" defaultValue={sp.shift ?? ""} className="input"><option value="">Semua shift</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>
      {people.length > 0 && (
        <Card className="mb-4" title="Hasil kerja per karyawan (dari laporan shift)">
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>Karyawan</th><th>Divisi</th><th>Rincian</th><th className="num">Total</th><th className="num">Shift</th></tr></thead>
              <tbody>{people.map((p) => (
                <tr key={`${p.division}${p.name}${p.cols.join()}`}><td>{p.name}</td><td>{p.division}</td><td className="text-sm">{p.cols.length > 1 ? p.cols.map((c, i) => `${c} ${p.values[i].toLocaleString("id-ID")}`).join(" · ") : "—"}</td><td className="num font-semibold">{p.total.toLocaleString("id-ID")}</td><td className="num">{p.reports}</td></tr>
              ))}</tbody>
            </table></Paged>
          </div>
        </Card>
      )}
      <Card className="mb-4" title={`Dari laporan shift · ${fmtDay(dateOnly(start))}${start !== end ? ` — ${fmtDay(dateOnly(end))}` : ""} · ${reports.length} laporan terkirim`}>
        {byDiv.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">Belum ada laporan shift terkirim pada periode ini</p> : (
          <div className="space-y-4">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Divisi</th><th className="num">Laporan</th><th>Ringkasan</th><th className="num">Capaian target</th></tr></thead>
                <tbody>
                  {byDiv.map((d) => (
                    <tr key={d.division}><td>{d.division}</td><td className="num">{d.reports}</td><td className="text-sm">{d.metrics.map(metricText).join(" · ")}</td><td className={`num font-semibold ${pctCls(d.target?.pct ?? null)}`}>{d.target ? `${d.target.pct}%` : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {start !== end && (
              <div className="table-wrap">
                <Paged><table className="tbl">
                  <thead><tr><th>Tanggal</th><th>Divisi · shift</th><th>Ringkasan</th><th className="num">Target</th></tr></thead>
                  <tbody>
                    {daily.map((r, i) => (
                      <tr key={i}><td className="whitespace-nowrap">{fmtDay(r.date)}</td><td>{r.division} · {r.shift}</td><td className="text-sm">{r.text}</td><td className={`num ${pctCls(r.pct)}`}>{r.pct == null ? "—" : `${r.pct}%`}</td></tr>
                    ))}
                  </tbody>
                </table></Paged>
              </div>
            )}
          </div>
        )}
      </Card>
      <Card title={`Dari input Produksi · ${fmtDay(dateOnly(start))}${start !== end ? ` — ${fmtDay(dateOnly(end))}` : ""}${shiftName ? ` · ${shiftName}` : ""}`}>
        {rows.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Tidak ada data produksi pada periode ini</p> : (
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>Divisi</th>{usedStages.map((s) => <th key={s} className="num">{STAGE_LABEL[s]}</th>)}<th className="num">Total</th><th className="num">Reject</th></tr></thead>
              <tbody>
                {usedDivs.map((d) => {
                  const tg = usedStages.reduce((s, st) => s + (cell(d.id, st)?.qtyGood ?? 0), 0);
                  const tr = usedStages.reduce((s, st) => s + (cell(d.id, st)?.qtyReject ?? 0), 0);
                  return (
                    <tr key={d.id}><td>{d.name}</td>{usedStages.map((s) => <td key={s} className="num">{cell(d.id, s)?.qtyGood ?? "-"}</td>)}<td className="num font-semibold">{tg}</td><td className="num text-rose-600">{tr}</td></tr>
                  );
                })}
              </tbody>
              <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={usedStages.length + 1}>Total</td><td className="num">{totalGood}</td><td className="num text-rose-600">{totalReject}</td></tr></tfoot>
            </table></Paged>
          </div>
        )}
      </Card>
      <DocExport>
        <DocSheet
          id="rekap" lh={lh} eyebrow="Laporan produksi" title={`Rekap Produksi ${period.charAt(0).toUpperCase() + period.slice(1)}`}
          subtitle={shiftName ? `${shiftName}${fixedDivision ? ` · ${divisions.find((d) => d.id === fixedDivision)?.name}` : ""}` : fixedDivision ? divisions.find((d) => d.id === fixedDivision)?.name : "Semua divisi & shift"}
          meta={{ label: "Periode Laporan", value: fmtRange(start, end) }} signer="Supervisor" signDate={end}
          notes={["Angka = jumlah hasil bagus (pcs); reject dihitung terpisah.", "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
        >
          <div className="mb-2 font-bold">Dari laporan shift ({reports.length} laporan terkirim)</div>
          <DocTable head={<tr><th>Divisi</th><th className="num">Laporan</th><th>Ringkasan</th><th className="num">Capaian target</th></tr>} empty={byDiv.length ? undefined : "Belum ada laporan shift terkirim pada periode ini"}>
            {byDiv.map((d) => (
              <tr key={d.division}><td>{d.division}</td><td className="num">{d.reports}</td><td>{d.metrics.map(metricText).join(" · ")}</td><td className={`num ${d.target && d.target.pct < 100 ? "doc-neg" : ""}`}>{d.target ? `${d.target.pct}%` : "—"}</td></tr>
            ))}
          </DocTable>
          <div className="mb-2 mt-4 font-bold">Dari input Produksi</div>
          <DocTable head={<tr><th>Divisi</th>{usedStages.map((s) => <th key={s} className="num">{STAGE_LABEL[s]}</th>)}<th className="num">Total</th><th className="num">Reject</th></tr>} empty={rows.length ? undefined : "Tidak ada data produksi pada periode ini"}>
            {usedDivs.map((d) => {
              const tg = usedStages.reduce((s, st) => s + (cell(d.id, st)?.qtyGood ?? 0), 0);
              const tr = usedStages.reduce((s, st) => s + (cell(d.id, st)?.qtyReject ?? 0), 0);
              return (
                <tr key={d.id}><td>{d.name}</td>{usedStages.map((s) => <td key={s} className="num">{cell(d.id, s)?.qtyGood?.toLocaleString("id-ID") ?? "-"}</td>)}<td className="num font-semibold">{tg.toLocaleString("id-ID")}</td><td className="num doc-neg">{tr.toLocaleString("id-ID")}</td></tr>
              );
            })}
          </DocTable>
          <DocSummary rows={[
            { label: "Total hasil bagus", value: `${totalGood.toLocaleString("id-ID")} pcs`, strong: true },
            { label: "Total reject", hint: totalGood + totalReject ? `${((totalReject / (totalGood + totalReject)) * 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}% dari total produksi` : undefined, value: `${totalReject.toLocaleString("id-ID")} pcs`, negative: totalReject > 0 },
          ]} />
        </DocSheet>
      </DocExport>
    </div>
  );
}
