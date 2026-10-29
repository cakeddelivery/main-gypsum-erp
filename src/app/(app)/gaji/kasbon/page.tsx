import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { createAdvance, repayAdvanceAction } from "../actions";

export const metadata = { title: "Kasbon Karyawan" };

export default async function KasbonPage() {
  const user = await requirePerm("payroll.view");
  const [advances, employees, banks, stores] = await Promise.all([
    prisma.cashAdvance.findMany({ include: { employee: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200 }),
    prisma.employee.findMany({ where: { status: { not: "NONAKTIF" } }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.store.findMany({ orderBy: { code: "asc" } }),
  ]);
  const open = advances.filter((a) => a.repaid < a.amount);
  const outstanding = open.reduce((s, a) => s + Number(a.amount - a.repaid), 0);
  const canGive = user.can("payroll.approve");
  const t = todayStr();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Kasbon karyawan"
        subtitle="Kasbon dipotong otomatis dari slip gaji / klaim borongan berikutnya dan tampil di slip"
        actions={
          <>
            <Link href="/gaji" className="btn-secondary">← Penggajian</Link>
            {canGive && (
              <Modal trigger="+ Kasbon" title="Kasbon baru">
                <ModalForm action={createAdvance} className="grid grid-cols-2 gap-3">
                  <Field label="Karyawan" className="col-span-2"><select name="employeeId" className="input">{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
                  <Field label="Nominal (IDR)"><input name="amount" inputMode="numeric" className="input" required /></Field>
                  <Field label="Cicilan per gajian" hint="0 = dipotong penuh di gajian berikutnya"><input name="installment" inputMode="numeric" defaultValue={0} className="input" /></Field>
                  <Field label="Dibayar dari"><select name="bankAccountId" defaultValue={banks.find((b) => b.code === "SEABANK")?.id} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Toko"><select name="storeId" defaultValue={stores.find((s) => s.code === "MG")?.id} className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                  <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
                  <Field label="Keperluan"><input name="note" className="input" /></Field>
                  <div className="col-span-2"><Submit>Simpan kasbon</Submit></div>
                </ModalForm>
              </Modal>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Kasbon belum lunas" value={idr(outstanding)} tone={outstanding ? "amber" : "slate"} />
        <Stat label="Karyawan berkasbon" value={new Set(open.map((a) => a.employeeId)).size} />
      </div>
      {advances.length === 0 ? <Empty title="Belum ada kasbon" /> : (
        <Card title="Daftar kasbon">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Karyawan</th><th className="num">Nominal</th><th className="num">Cicilan</th><th className="num">Sudah dipotong</th><th className="num">Sisa</th><th>Status</th><th /></tr></thead>
              <tbody>
                {advances.map((a) => {
                  const rem = Number(a.amount - a.repaid);
                  return (
                    <tr key={a.id}>
                      <td className="font-mono text-xs">{a.number}</td><td>{fmtDay(a.date)}</td><td>{a.employee.name}{a.note && <div className="text-xs text-slate-400">{a.note}</div>}</td>
                      <td className="num">{idr(a.amount)}</td><td className="num">{Number(a.installment) ? idr(a.installment) : "Penuh"}</td><td className="num">{idr(a.repaid)}</td><td className="num font-semibold">{idr(rem)}</td>
                      <td>{rem === 0 ? <Badge tone="green">Lunas</Badge> : <Badge tone="amber">Berjalan</Badge>}</td>
                      <td>{rem > 0 && canGive && (
                        <Modal trigger="Lunasi" triggerClass="btn-secondary btn-sm" title={`Pelunasan ${a.number}`}>
                          <ModalForm action={repayAdvanceAction} className="space-y-3">
                            <input type="hidden" name="id" value={a.id} />
                            <Field label="Diterima di rekening"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                            <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
                            <Field label={`Nominal (sisa ${idr(rem)})`}><input name="amount" defaultValue={rem} inputMode="numeric" className="input" /></Field>
                            <p className="text-xs text-slate-500">Untuk pelunasan di luar potongan gaji. Potongan lewat gaji tercatat otomatis saat gaji dibayar.</p>
                            <Submit>Bukukan</Submit>
                          </ModalForm>
                        </Modal>
                      )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
