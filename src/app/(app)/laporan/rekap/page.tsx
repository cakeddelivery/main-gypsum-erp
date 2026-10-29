import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, fmtDay, todayStr } from "@/lib/time";
import { Paged } from "@/components/Paged";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Card, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport, DocSheet, DocSummary, DocTable, fmtRange } from "@/components/DocSheet";
import { letterhead } from "@/lib/letterhead";

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
  const sp = await searchParams;
  const period = ["harian", "mingguan", "bulanan"].includes(sp.period ?? "") ? sp.period! : "harian";
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayStr();
  const { start, end } = range(period, date);
  const fixedDivision = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" ? user.divisionId : null;
  const where = { date: { gte: dateOnly(start), lte: dateOnly(end) }, ...(sp.shift ? { shiftId: sp.shift } : {}), ...(fixedDivision ? { divisionId: fixedDivision } : {}) };
  const [rows, divisions, shifts] = await Promise.all([
    prisma.productionEntry.groupBy({ by: ["divisionId", "stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.division.findMany({ orderBy: { code: "asc" } }),
    prisma.shift.findMany({ orderBy: { code: "asc" } }),
  ]);
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
      <PageHeader title="Rekap produksi" subtitle="Laporan per shift, harian, mingguan, dan bulanan" actions={<DownloadJpg targetId="rekap" filename={`rekap-${period}-${start}`} />} />
      <Tabs current={period} tabs={[{ key: "harian", label: "Harian", href: qs("harian") }, { key: "mingguan", label: "Mingguan", href: qs("mingguan") }, { key: "bulanan", label: "Bulanan", href: qs("bulanan") }]} />
      <FilterBar>
        <input type="hidden" name="period" value={period} />
        <Field label="Tanggal acuan"><input type="date" name="date" defaultValue={date} className="input" /></Field>
        <Field label="Shift"><select name="shift" defaultValue={sp.shift ?? ""} className="input"><option value="">Semua shift</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>
      <Card title={`Rekap ${period} · ${fmtDay(dateOnly(start))}${start !== end ? ` — ${fmtDay(dateOnly(end))}` : ""}${shiftName ? ` · ${shiftName}` : ""}`}>
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
