import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dateOnly, fmtDay, todayStr } from "@/lib/time";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Card, Empty, FilterBar, PageHeader, Field } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ActionForm, Submit } from "@/components/ActionForm";
import { EntryForm } from "./EntryForm";
import { deleteEntry } from "./actions";
import type { Prisma } from "@prisma/client";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";

export const metadata = { title: "Produksi" };

export default async function ProduksiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePerm("production.view");
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayStr();
  const isOp = user.role === "OPERATOR";
  const fixedDivision = user.role === "KAPTEN_DIVISI" ? user.divisionId : null;
  const where: Prisma.ProductionEntryWhereInput = {
    date: dateOnly(date),
    ...(sp.shift ? { shiftId: sp.shift } : {}),
    ...(fixedDivision ? { divisionId: fixedDivision } : sp.division ? { divisionId: sp.division } : {}),
    ...(sp.stage ? { stage: sp.stage as never } : {}),
    ...(isOp ? { employeeId: user.employeeId ?? "__none__" } : {}),
  };
  const [entries, shifts, divisions, employees, products, byStage] = await Promise.all([
    prisma.productionEntry.findMany({ where, include: { shift: true, division: true, employee: true, product: true }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.employee.findMany({ where: { status: "AKTIF" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.productionEntry.groupBy({ by: ["stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
  ]);
  const stageMap = new Map(byStage.map((s) => [s.stage, s._sum]));
  const totalGood = entries.reduce((s, e) => s + e.qtyGood, 0);
  const totalReject = entries.reduce((s, e) => s + e.qtyReject, 0);

  return (
    <div>
      <PageHeader
        title="Produksi"
        subtitle={`Hasil produksi ${fmtDay(dateOnly(date))}`}
        actions={
          <>
            <DownloadCsv filename={`produksi-${date}`} rows={[["Tanggal", "Shift", "Divisi", "Karyawan", "Tahap", "Produk", "Hasil baik", "Reject", "Penyebab reject", "Catatan"], ...entries.map((e) => [date, e.shift.name, e.division.name, e.employee.name, STAGE_LABEL[e.stage], e.product.name, e.qtyGood, e.qtyReject, e.rejectReason ?? "", e.note ?? ""])]} />
            {user.can("production.target") && <Link href="/produksi/target" className="btn-secondary">Target</Link>}
            {user.can("production.create") && (
              <Modal trigger="+ Input hasil" title="Input hasil produksi" defaultOpen={sp.baru === "1"}>
                <EntryForm
                  date={date}
                  shifts={shifts}
                  divisions={divisions}
                  employees={employees}
                  products={products}
                  stages={STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
                  fixedEmployee={isOp ? user.employeeId : null}
                  fixedDivision={fixedDivision}
                />
              </Modal>
            )}
          </>
        }
      />

      <Card title="Alur produksi" className="mb-4">
        <ol className="flex gap-2 overflow-x-auto pb-1 text-xs">
          {STAGES.map((s, i) => {
            const v = stageMap.get(s);
            return (
              <li key={s} className="flex items-center gap-2">
                <div className={`min-w-[92px] rounded-lg border px-2.5 py-2 ${v ? "border-brand-200 bg-brand-50" : "border-slate-200"}`}>
                  <div className="font-medium text-slate-700">{STAGE_LABEL[s]}</div>
                  <div className="tabular-nums text-slate-500">{v?.qtyGood ?? 0} <span className="text-rose-500">· {v?.qtyReject ?? 0} rj</span></div>
                </div>
                {i < STAGES.length - 1 && <span className="text-slate-300">→</span>}
              </li>
            );
          })}
        </ol>
      </Card>

      <FilterBar>
        <Field label="Tanggal"><input type="date" name="date" defaultValue={date} className="input" /></Field>
        <Field label="Shift">
          <select name="shift" defaultValue={sp.shift ?? ""} className="input"><option value="">Semua</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        {!fixedDivision && !isOp && (
          <Field label="Divisi">
            <select name="division" defaultValue={sp.division ?? ""} className="input"><option value="">Semua</option>{divisions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
        )}
        <Field label="Tahap">
          <select name="stage" defaultValue={sp.stage ?? ""} className="input"><option value="">Semua</option>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select>
        </Field>
      </FilterBar>

      {entries.length === 0 ? (
        <Empty title="Belum ada hasil produksi" hint="Catat hasil per karyawan, tahap, dan shift dengan tombol Input hasil." />
      ) : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead>
              <tr><th>Shift</th><th>Divisi</th><th>Karyawan</th><th>Tahap</th><th>Produk</th><th className="num">Hasil</th><th className="num">Reject</th><th>Catatan</th>{user.can("production.edit") && <th />}</tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.shift.name}</td>
                  <td>{e.division.name}</td>
                  <td>{e.employee.name}</td>
                  <td>{STAGE_LABEL[e.stage]}</td>
                  <td>{e.product.name}</td>
                  <td className="num">{e.qtyGood}</td>
                  <td className="num text-rose-600">{e.qtyReject}{e.rejectReason && <div className="text-[11px] font-normal text-slate-400">{e.rejectReason}</div>}</td>
                  <td className="max-w-[200px] truncate text-slate-500">{e.note}</td>
                  {user.can("production.edit") && (
                    <td>
                      <ActionForm action={deleteEntry} confirm="Hapus entri ini? Mutasi stok & jurnal terkait akan dibalik.">
                        <input type="hidden" name="id" value={e.id} />
                        <Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold"><td colSpan={5}>Total</td><td className="num">{totalGood}</td><td className="num text-rose-600">{totalReject}</td><td colSpan={2} /></tr>
            </tfoot>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
