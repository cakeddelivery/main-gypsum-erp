import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { BUDGET_OVER, BUDGET_TYPES, BUDGET_WARN, budgetReport, monthKey, monthLabel, parseMonth, prevMonth, type BudgetRow } from "@/lib/budget";
import { Badge, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadCsv } from "@/components/DownloadCsv";
import { Paged } from "@/components/Paged";
import { copyBudgetAction, deleteBudgetAction, saveBudgetAction } from "./actions";
import type { SP } from "../shared";

export const metadata = { title: "Anggaran Beban" };

const LEVEL: Record<BudgetRow["level"], { label: string; tone: "green" | "amber" | "red" | "gray"; bar: string }> = {
  AMAN: { label: "Aman", tone: "green", bar: "bg-emerald-500" },
  WASPADA: { label: `≥${BUDGET_WARN}%`, tone: "amber", bar: "bg-amber-500" },
  LEWAT: { label: "Lewat anggaran", tone: "red", bar: "bg-rose-500" },
  TANPA: { label: "Belum dianggarkan", tone: "gray", bar: "bg-slate-400" },
};

function Meter({ pct, level }: { pct: number | null; level: BudgetRow["level"] }) {
  if (pct === null) return <span className="text-xs text-slate-400">-</span>;
  return (
    <div className="flex min-w-[7rem] items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${LEVEL[level].bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className={`w-12 text-right text-xs font-semibold tabular-nums ${level === "LEWAT" ? "text-rose-600" : level === "WASPADA" ? "text-amber-700" : "text-slate-600"}`}>{pct.toLocaleString("id-ID")}%</span>
    </div>
  );
}

export default async function AnggaranPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("accounting.view");
  const sp = await searchParams;
  const { year, month } = parseMonth(sp.bulan);
  const key = monthKey(year, month);
  const prev = prevMonth(year, month);
  const [report, accounts, prevCount] = await Promise.all([
    budgetReport(year, month),
    prisma.coaAccount.findMany({ where: { type: { in: [...BUDGET_TYPES] }, active: true }, orderBy: { code: "asc" } }),
    prisma.expenseBudget.count({ where: { year: prev.year, month: prev.month } }),
  ]);
  const canEdit = user.can("accounting.post");
  const period = monthLabel(year, month);
  const over = report.rows.filter((r) => r.level === "LEWAT").length;
  const warn = report.rows.filter((r) => r.level === "WASPADA").length;

  const form = (r?: BudgetRow) => (
    <ModalForm action={saveBudgetAction} className="grid grid-cols-2 gap-3">
      <input type="hidden" name="month" value={key} />
      <Field label="Bulan" className="col-span-2"><input className="input" value={period} readOnly disabled /></Field>
      {r ? (
        <>
          <input type="hidden" name="accountId" value={r.accountId} />
          <Field label="Akun beban" className="col-span-2"><input className="input" value={`${r.code} ${r.name}`} readOnly disabled /></Field>
        </>
      ) : (
        <Field label="Akun beban" className="col-span-2" hint="Akun yang sudah punya anggaran bulan ini akan diperbarui">
          <select name="accountId" className="input" required defaultValue="">
            <option value="" disabled>Pilih akun</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Anggaran (Rp)" className="col-span-2"><input name="amount" inputMode="numeric" className="input" defaultValue={r?.budget ? r.budget.toLocaleString("id-ID") : ""} required /></Field>
      <Field label="Catatan (opsional)" className="col-span-2"><input name="note" className="input" defaultValue={r?.note ?? ""} /></Field>
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );

  const csv: (string | number)[][] = [[`Anggaran beban ${period}`], [], ["Kode", "Akun", "Anggaran (Rp)", "Realisasi (Rp)", "Sisa (Rp)", "Persen", "Status"]];
  for (const r of report.rows) csv.push([r.code, r.name, r.budget, r.actual, r.remaining, r.pct ?? "", LEVEL[r.level].label]);
  csv.push(["", "Total", report.totalBudget, report.totalActual, report.totalBudget - report.budgetedActual, report.total.pct ?? "", ""]);

  return (
    <div>
      <PageHeader
        title="Anggaran beban"
        subtitle={`Realisasi dihitung dari jurnal (termasuk gaji, borongan, pembelian, transaksi). Peringatan muncul saat realisasi ≥${BUDGET_WARN}% dan ≥${BUDGET_OVER}%.`}
        actions={<>
          <DownloadCsv filename={`anggaran-beban-${key}`} rows={csv} />
          {canEdit && prevCount > 0 && (
            <ActionForm action={copyBudgetAction} confirm={`Salin ${prevCount} anggaran dari ${monthLabel(prev.year, prev.month)} ke ${period}? Akun yang sudah ada anggarannya tidak ditimpa.`}>
              <input type="hidden" name="month" value={key} />
              <Submit className="btn-secondary">Salin dari {monthLabel(prev.year, prev.month)}</Submit>
            </ActionForm>
          )}
          {canEdit && <Modal trigger="+ Anggaran" title={`Anggaran ${period}`}>{form()}</Modal>}
        </>}
      />
      <FilterBar>
        <Field label="Bulan"><input type="month" name="bulan" defaultValue={key} className="input" /></Field>
      </FilterBar>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Total anggaran ${period}`} value={idr(report.totalBudget)} />
        <Stat label="Realisasi (akun dianggarkan)" value={idr(report.budgetedActual)} hint={report.total.pct !== null ? `${report.total.pct.toLocaleString("id-ID")}% dari anggaran` : undefined} tone={report.total.level === "LEWAT" ? "red" : report.total.level === "WASPADA" ? "amber" : "slate"} />
        <Stat label="Sisa anggaran" value={idr(report.totalBudget - report.budgetedActual)} tone={report.totalBudget - report.budgetedActual < 0 ? "red" : "green"} />
        <Stat label="Akun lewat / ≥80%" value={`${over} / ${warn}`} tone={over ? "red" : warn ? "amber" : "slate"} hint={report.totalActual !== report.budgetedActual ? `Beban belum dianggarkan: ${idr(report.totalActual - report.budgetedActual)}` : undefined} />
      </div>
      {report.rows.length === 0 ? (
        <Empty title={`Belum ada anggaran untuk ${period}`} hint={canEdit ? (prevCount ? `Tekan "Salin dari ${monthLabel(prev.year, prev.month)}" atau "+ Anggaran".` : `Tekan "+ Anggaran" untuk mulai.`) : undefined} />
      ) : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Kode</th><th>Akun</th><th className="num">Anggaran</th><th className="num">Realisasi</th><th className="num">Sisa</th><th>Persen</th><th>Status</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.accountId}>
                  <td className="font-mono text-xs">{r.code}</td>
                  <td>{r.name}{r.note && <div className="text-xs text-slate-500">{r.note}</div>}</td>
                  <td className="num">{r.budgetId ? idr(r.budget) : "-"}</td>
                  <td className="num">{idr(r.actual)}</td>
                  <td className={`num ${r.remaining < 0 ? "text-rose-600" : ""}`}>{r.budgetId ? idr(r.remaining) : "-"}</td>
                  <td><Meter pct={r.pct} level={r.level} /></td>
                  <td><Badge tone={LEVEL[r.level].tone}>{LEVEL[r.level].label}</Badge></td>
                  {canEdit && (
                    <td>
                      <div className="flex gap-1">
                        <Modal trigger={r.budgetId ? "Ubah" : "Anggarkan"} triggerClass="btn-secondary btn-sm" title={`Anggaran ${period}`}>{form(r)}</Modal>
                        {r.budgetId && (
                          <ActionForm action={deleteBudgetAction} confirm={`Hapus anggaran ${r.name} untuk ${period}?`}>
                            <input type="hidden" name="id" value={r.budgetId} />
                            <Submit className="btn-danger btn-sm">Hapus</Submit>
                          </ActionForm>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={2}>Total</td><td className="num">{idr(report.totalBudget)}</td><td className="num">{idr(report.totalActual)}</td><td className="num">{idr(report.totalBudget - report.budgetedActual)}</td><td><Meter pct={report.total.pct} level={report.total.level} /></td><td colSpan={canEdit ? 2 : 1} /></tr></tfoot>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
