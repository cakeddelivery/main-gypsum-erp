import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dateOnly, fmtDay, todayStr } from "@/lib/time";
import { Badge, Card, FilterBar, Field, PageHeader } from "@/components/ui";
import { openReport } from "./actions";

export const metadata = { title: "Laporan Shift" };

export default async function LaporanPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requirePerm("report.view");
  const { date: d } = await searchParams;
  const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayStr();
  const fixedDivision = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" ? user.divisionId : null;
  const [shifts, divisions, reports, prod] = await Promise.all([
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.division.findMany({ where: { active: true, ...(fixedDivision ? { id: fixedDivision } : {}) }, orderBy: { code: "asc" } }),
    prisma.shiftReport.findMany({ where: { date: dateOnly(date) }, include: { sends: { orderBy: { sentAt: "desc" }, take: 1 } } }),
    prisma.productionEntry.groupBy({ by: ["shiftId", "divisionId"], where: { date: dateOnly(date) }, _sum: { qtyGood: true, qtyReject: true } }),
  ]);
  return (
    <div>
      <PageHeader title="Laporan shift" subtitle={`Laporan per divisi & shift · ${fmtDay(dateOnly(date))}`} actions={<Link href="/laporan/rekap" className="btn-secondary">Rekap harian/mingguan/bulanan</Link>} />
      <FilterBar>
        <Field label="Tanggal"><input type="date" name="date" defaultValue={date} className="input" /></Field>
      </FilterBar>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {divisions.map((div) => (
          <Card key={div.id} title={div.name}>
            <ul className="space-y-2">
              {shifts.map((s) => {
                const r = reports.find((x) => x.shiftId === s.id && x.divisionId === div.id);
                const p = prod.find((x) => x.shiftId === s.id && x.divisionId === div.id);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                    <div>
                      <div className="text-sm font-medium">{s.name} <span className="text-xs text-slate-400">{s.startTime}–{s.endTime}</span></div>
                      <div className="text-xs text-slate-500">Hasil {p?._sum.qtyGood ?? 0} · Reject {p?._sum.qtyReject ?? 0}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {r ? <Badge tone={r.status === "TERKIRIM" ? "green" : r.status === "DIREVISI" ? "purple" : "amber"}>{r.status === "TERKIRIM" ? "Terkirim" : r.status === "DIREVISI" ? "Direvisi" : "Draft"}</Badge> : <Badge tone="red">Belum dibuat</Badge>}
                      {r ? (
                        <Link href={`/laporan/${r.id}`} className="btn-secondary btn-sm">Buka</Link>
                      ) : (
                        user.can("report.create") && (
                          <form action={openReport}>
                            <input type="hidden" name="date" value={date} />
                            <input type="hidden" name="shiftId" value={s.id} />
                            <input type="hidden" name="divisionId" value={div.id} />
                            <button className="btn-primary btn-sm">Buat</button>
                          </form>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
