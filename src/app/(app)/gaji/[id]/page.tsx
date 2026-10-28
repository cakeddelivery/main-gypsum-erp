import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime, fmtDay, todayStr } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { adjustSlip, approve, compute, pay } from "../actions";

export const metadata = { title: "Periode Penggajian" };

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("payroll.view");
  const { id } = await params;
  const p = await prisma.payrollPeriod.findUnique({ where: { id }, include: { payslips: { include: { employee: { include: { division: true } } }, orderBy: { employee: { name: "asc" } } } } });
  if (!p) notFound();
  const [banks, stores, journal] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.store.findMany(),
    p.journalId ? prisma.journal.findUnique({ where: { id: p.journalId } }) : null,
  ]);
  const sum = (k: "dailyWage" | "pieceWage" | "transport" | "total") => p.payslips.reduce((s, x) => s + Number(x[k]), 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Penggajian ${p.code}`}
        subtitle={`${fmtDay(p.startDate)} – ${fmtDay(p.endDate)}`}
        actions={
          <>
            <Link href="/gaji" className="btn-secondary">← Kembali</Link>
            {p.status === "DRAFT" && user.can("payroll.manage") && <ActionForm action={compute}><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary" pendingText="Menghitung…">Hitung ulang</Submit></ActionForm>}
            {p.status === "DRAFT" && user.can("payroll.approve") && p.payslips.length > 0 && <ActionForm action={approve} confirm="Setujui penggajian ini? Slip tidak bisa dihitung ulang setelah disetujui."><input type="hidden" name="id" value={p.id} /><Submit className="btn-success">Setujui</Submit></ActionForm>}
            {p.status === "DISETUJUI" && user.can("payroll.approve") && (
              <Modal trigger="Bayar gaji" title="Pembayaran gaji">
                <ModalForm action={pay} className="space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Dibayar dari rekening"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Toko (pembebanan)"><select name="storeId" className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                  <Field label="Tanggal bayar"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
                  <p className="text-sm">Total dibayar: <b>{idr(sum("total"))}</b>. Jurnal beban gaji & transport dibuat otomatis.</p>
                  <Submit className="btn-success">Bayar & bukukan</Submit>
                </ModalForm>
              </Modal>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Status" value={<Badge tone={p.status === "DIBAYAR" ? "green" : p.status === "DISETUJUI" ? "blue" : "amber"}>{p.status}</Badge>} hint={p.approvedBy ? `Disetujui ${p.approvedBy}` : undefined} />
        <Stat label="Upah harian" value={idr(sum("dailyWage"))} />
        <Stat label="Upah borongan" value={idr(sum("pieceWage"))} />
        <Stat label="Transport assembling" value={idr(sum("transport"))} />
        <Stat label="Total" value={idr(sum("total"))} tone="blue" hint={journal ? `Jurnal ${journal.number} · ${fmtDateTime(p.paidAt)}` : undefined} />
      </div>
      {p.payslips.length === 0 ? <Empty title="Belum ada slip" hint="Klik Hitung ulang untuk menghitung dari absensi tervalidasi, hasil borongan, dan transport." /> : (
        <Card title="Slip gaji">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Karyawan</th><th>Divisi</th><th className="num">Hari</th><th className="num">Harian</th><th className="num">Borongan</th><th className="num">Transport</th><th className="num">Bonus</th><th className="num">Potongan</th><th className="num">Total</th><th /></tr></thead>
              <tbody>
                {p.payslips.map((s) => (
                  <tr key={s.id}>
                    <td>{s.employee.name}</td><td>{s.employee.division.name}</td><td className="num">{s.daysPresent}</td><td className="num">{idr(s.dailyWage)}</td><td className="num">{idr(s.pieceWage)}</td><td className="num">{idr(s.transport)}</td><td className="num">{idr(s.bonus)}</td><td className="num text-rose-600">{idr(s.deduction)}</td><td className="num font-semibold">{idr(s.total)}</td>
                    <td className="flex gap-1">
                      <Link href={`/gaji/slip/${s.id}`} className="btn-secondary btn-sm">Slip</Link>
                      {p.status === "DRAFT" && user.can("payroll.manage") && (
                        <Modal trigger="Sesuaikan" triggerClass="btn-secondary btn-sm" title={`Penyesuaian ${s.employee.name}`}>
                          <ModalForm action={adjustSlip} className="space-y-3">
                            <input type="hidden" name="id" value={s.id} />
                            <Field label="Bonus (IDR)"><input name="bonus" defaultValue={Number(s.bonus)} inputMode="numeric" className="input" /></Field>
                            <Field label="Potongan (IDR)"><input name="deduction" defaultValue={Number(s.deduction)} inputMode="numeric" className="input" /></Field>
                            <Submit>Simpan</Submit>
                          </ModalForm>
                        </Modal>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
