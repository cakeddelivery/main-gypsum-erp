import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addTrip, saveRate } from "../actions";

export const metadata = { title: "Tarif Borongan & Transport" };

export default async function TarifPage() {
  await requirePerm("payroll.manage");
  const [rates, employees, trips] = await Promise.all([
    prisma.pieceRate.findMany(),
    prisma.employee.findMany({ where: { status: "AKTIF" }, orderBy: { name: "asc" } }),
    prisma.transportTrip.findMany({ include: { employee: true }, orderBy: { date: "desc" }, take: 50 }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Tarif borongan & transport assembling" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Tarif borongan per pcs">
          <ul className="mb-4 divide-y divide-slate-100 text-sm">{rates.map((r) => <li key={r.id} className="flex justify-between py-1.5"><span>{STAGE_LABEL[r.stage]}</span><span className="tabular-nums">{idr(r.ratePerPcs)}/pcs</span></li>)}</ul>
          <ActionForm action={saveRate} className="flex flex-wrap items-end gap-2">
            <Field label="Tahap"><select name="stage" className="input">{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></Field>
            <Field label="Tarif/pcs (IDR)"><input name="ratePerPcs" inputMode="numeric" className="input" required /></Field>
            <Submit>Simpan</Submit>
          </ActionForm>
        </Card>
        <Card title="Catat transport assembling">
          <ActionForm action={addTrip} resetOnSuccess className="grid grid-cols-2 gap-3">
            <Field label="Karyawan" className="col-span-2"><select name="employeeId" className="input">{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
            <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
            <Field label="Nominal (IDR)"><input name="amount" inputMode="numeric" className="input" required /></Field>
            <Field label="Catatan" className="col-span-2"><input name="note" className="input" /></Field>
            <div className="col-span-2"><Submit>Simpan</Submit></div>
          </ActionForm>
          <ul className="mt-4 divide-y divide-slate-100 text-sm">{trips.map((t) => <li key={t.id} className="flex justify-between py-1.5"><span>{fmtDay(t.date)} · {t.employee.name}</span><span className="tabular-nums">{idr(t.amount)}</span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
