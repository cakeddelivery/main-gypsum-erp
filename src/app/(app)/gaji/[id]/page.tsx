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
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { adjustSlip, approve, cancelClaim, compute, pay } from "../actions";

export const metadata = { title: "Periode Penggajian" };

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("payroll.view");
  const { id } = await params;
  const p = await prisma.payrollPeriod.findUnique({ where: { id }, include: { payslips: { include: { employee: { include: { division: true } } }, orderBy: { employee: { name: "asc" } } } } });
  if (!p) notFound();
  const [banks, journal] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true } }),
    p.journalId ? prisma.journal.findUnique({ where: { id: p.journalId } }) : null,
  ]);
  const sum = (k: "baseSalary" | "dailyWage" | "pieceWage" | "allowance" | "transport" | "total") => p.payslips.reduce((s, x) => s + Number(x[k]), 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Penggajian ${p.code}`}
        subtitle={`${p.kind === "BULANAN" ? "Gaji bulanan" : p.kind === "BORONGAN" ? "Klaim borongan" : "Upah harian/campuran"} · ${fmtDay(p.startDate)} – ${fmtDay(p.endDate)}${p.payDate ? ` · gajian ${fmtDay(p.payDate)}` : ""}`}
        actions={
          <>
            <DownloadCsv filename={`gaji-${p.code}`} rows={[["Karyawan", "Divisi", "Hadir", "Libur", "Bolos", "Gaji pokok", "Upah harian", "Borongan", "Tunjangan", "Transport", "Bonus", "Potongan", "Kasbon", "Total"], ...p.payslips.map((x) => [x.employee.name, x.employee.division?.name ?? "", x.daysPresent, x.offDays, x.absentDays, Number(x.baseSalary), Number(x.dailyWage), Number(x.pieceWage), Number(x.allowance), Number(x.transport), Number(x.bonus), Number(x.deduction), Number(x.advanceDeduction), Number(x.total)])]} />
            {p.status === "DRAFT" && user.can("payroll.manage") && <ActionForm action={compute}><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary" pendingText="Menghitung…">Hitung ulang</Submit></ActionForm>}
            {p.kind === "BORONGAN" && p.status === "DRAFT" && user.can("payroll.manage") && <ActionForm action={cancelClaim} confirm="Batalkan klaim ini? Hasil borongan kembali menjadi belum diklaim."><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary">Batalkan klaim</Submit></ActionForm>}
            {p.status === "DRAFT" && user.can("payroll.approve") && p.payslips.length > 0 && <ActionForm action={approve} confirm="Setujui penggajian ini? Slip tidak bisa dihitung ulang setelah disetujui."><input type="hidden" name="id" value={p.id} /><Submit className="btn-success">Setujui</Submit></ActionForm>}
            {p.status === "DISETUJUI" && user.can("payroll.approve") && (
              <Modal trigger="Bayar gaji" title="Pembayaran gaji">
                <ModalForm action={pay} className="space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Dibayar dari rekening"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
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
        {p.kind === "BULANAN" ? <Stat label="Gaji pokok" value={idr(sum("baseSalary"))} /> : p.kind === "TUNJANGAN" ? <Stat label="Tunjangan" value={idr(sum("allowance"))} /> : <Stat label="Upah harian" value={idr(sum("dailyWage"))} />}
        <Stat label="Upah borongan" value={idr(sum("pieceWage"))} />
        <Stat label="Transport assembling" value={idr(sum("transport"))} />
        <Stat label="Total" value={idr(sum("total"))} tone="blue" hint={journal ? `Jurnal ${journal.number} · ${fmtDateTime(p.paidAt)}` : undefined} />
      </div>
      {p.payslips.length === 0 ? <Empty title="Belum ada slip" hint={p.kind === "BULANAN" ? "Belum ada karyawan bulanan yang siklusnya cocok dengan periode ini." : "Klik Hitung ulang untuk menghitung dari absensi tervalidasi, hasil borongan, dan transport."} /> : (
        <Card title="Slip gaji">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>Karyawan</th><th>Divisi</th><th className="num">Hadir</th>{p.kind === "BULANAN" && <><th className="num">Libur</th><th className="num">Bolos</th><th className="num">Gaji pokok</th></>}<th className="num">Harian</th><th className="num">Borongan</th>{p.kind === "TUNJANGAN" && <th className="num">Tunjangan</th>}<th className="num">Transport</th><th className="num">Bonus</th><th className="num">Potongan</th><th className="num">Kasbon</th><th className="num">Total</th><th /></tr></thead>
              <tbody>
                {p.payslips.map((s) => (
                  <tr key={s.id}>
                    <td>{s.employee.name}</td><td>{s.employee.division.name}</td><td className="num">{s.daysPresent}</td>{p.kind === "BULANAN" && <><td className="num">{s.offDays}</td><td className={`num ${s.absentDays ? "text-rose-600" : ""}`}>{s.absentDays}</td><td className="num">{idr(s.baseSalary)}</td></>}<td className="num">{idr(s.dailyWage)}</td><td className="num">{idr(s.pieceWage)}</td>{p.kind === "TUNJANGAN" && <td className="num">{idr(s.allowance)}</td>}<td className="num">{idr(s.transport)}</td><td className="num">{idr(s.bonus)}</td><td className="num text-rose-600">{idr(s.deduction)}</td><td className="num text-rose-600">{idr(s.advanceDeduction)}</td><td className="num font-semibold">{idr(s.total)}{s.note && <div className="text-xs font-normal text-slate-400">{s.note}</div>}</td>
                    <td><div className="flex gap-1">
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
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table></Paged>
          </div>
        </Card>
      )}
    </div>
  );
}
