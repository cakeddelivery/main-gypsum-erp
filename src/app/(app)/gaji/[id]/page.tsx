import { alpaInfo } from "@/lib/payroll";
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
import { adjustSlip, approve, cancelClaim, cancelPay, compute, pay, unapprove } from "../actions";

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
  // Koreksi absensi (Alpa) setelah slip disetujui: slip TIDAK berubah otomatis; beri tahu agar bisa ditinjau
  const changed: { name: string; was: number; now: number }[] = [];
  if (p.kind === "BULANAN" && p.status !== "DRAFT") {
    const alpa = await prisma.attendance.findMany({ where: { employeeId: { in: p.payslips.map((x) => x.employeeId) }, status: "ALPA", date: { gte: p.startDate, lte: p.endDate } }, select: { employeeId: true, date: true } });
    for (const x of p.payslips) {
      // Hanya slip yang dihitung dengan aturan Alpa (slip lama memakai aturan bolos)
      const info = alpaInfo(x.alpaDetail);
      if (!info) continue;
      // Hitungan absen dimulai dari tanggal go-live (bila jatuh di tengah siklus); siklus sebelum go-live tidak dihitung
      if (!info.from) continue;
      const now = alpa.filter((a) => a.employeeId === x.employeeId && a.date.toISOString().slice(0, 10) >= info.from!).length;
      if (now !== info.dates.length) changed.push({ name: x.employee.name, was: info.dates.length, now });
    }
  }
  const sum = (k: "baseSalary" | "dailyWage" | "pieceWage" | "allowance" | "transport" | "total") => p.payslips.reduce((s, x) => s + Number(x[k]), 0);
  // Slip yang sudah dibayar satu per satu (mis. dari bot Telegram)
  const paidSlips = p.payslips.filter((x) => x.paidAt);
  const unpaidTotal = p.payslips.filter((x) => !x.paidAt).reduce((s, x) => s + Number(x.total), 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Penggajian ${p.code}`}
        subtitle={`${p.kind === "BULANAN" ? "Gaji bulanan" : p.kind === "BORONGAN" ? "Klaim borongan" : "Upah harian/campuran"} · ${fmtDay(p.startDate)} – ${fmtDay(p.endDate)}${p.payDate ? ` · gajian ${fmtDay(p.payDate)}` : ""}`}
        actions={
          <>
            <DownloadCsv filename={`gaji-${p.code}`} rows={[["Karyawan", "Divisi", "Hadir", "Libur", "Alpa", "Telat (kali)", "Telat (menit)", "Gaji pokok", "Upah harian", "Borongan", "Tunjangan", "Transport", "Bonus", "Potongan Alpa", "Potongan lain", "Kasbon", "Total"], ...p.payslips.map((x) => [x.employee.name, x.employee.division?.name ?? "", x.daysPresent, x.offDays, x.absentDays, x.lateCount, x.lateMinutes, Number(x.baseSalary), Number(x.dailyWage), Number(x.pieceWage), Number(x.allowance), Number(x.transport), Number(x.bonus), Number(x.alpaDeduction), Number(x.deduction), Number(x.advanceDeduction), Number(x.total)])]} />
            {p.status === "DRAFT" && user.can("payroll.manage") && <ActionForm action={compute}><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary" pendingText="Menghitung…">Hitung ulang</Submit></ActionForm>}
            {p.kind === "BORONGAN" && p.status === "DRAFT" && user.can("payroll.manage") && <ActionForm action={cancelClaim} confirm="Batalkan klaim ini? Hasil borongan kembali menjadi belum diklaim."><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary">Batalkan klaim</Submit></ActionForm>}
            {p.status === "DRAFT" && user.can("payroll.approve") && p.payslips.length > 0 && <ActionForm action={approve} confirm="Setujui penggajian ini? Slip tidak bisa dihitung ulang setelah disetujui."><input type="hidden" name="id" value={p.id} /><Submit className="btn-success">Setujui</Submit></ActionForm>}
            {p.status === "DISETUJUI" && !paidSlips.length && user.can("payroll.approve") && (
              <Modal trigger="Batalkan persetujuan" triggerClass="btn-secondary" title="Kembalikan ke draft">
                <ModalForm action={unapprove} className="space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                  <p className="text-xs text-slate-500">Jurnal hutang gaji dibalik; periode kembali draft agar bisa dihitung ulang.</p>
                  <Submit className="btn-danger">Kembalikan ke draft</Submit>
                </ModalForm>
              </Modal>
            )}
            {(p.status === "DIBAYAR" || paidSlips.length > 0) && user.can("payroll.approve") && (
              <Modal trigger="Batalkan pembayaran" triggerClass="btn-secondary" title="Batalkan pembayaran gaji">
                <ModalForm action={cancelPay} className="space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                  <p className="text-xs text-slate-500">Semua jurnal pembayaran periode ini dibalik (termasuk slip yang dibayar satu per satu dari bot), potongan kasbon dikembalikan, status kembali Disetujui.</p>
                  <Submit className="btn-danger">Batalkan pembayaran</Submit>
                </ModalForm>
              </Modal>
            )}
            {p.status === "DISETUJUI" && user.can("payroll.approve") && (
              <Modal trigger="Bayar gaji" title="Pembayaran gaji">
                <ModalForm action={pay} className="space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Dibayar dari rekening"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Tanggal bayar"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
                  <p className="text-sm">Total dibayar: <b>{idr(unpaidTotal)}</b>{paidSlips.length ? ` (${paidSlips.length} slip sudah dibayar sebelumnya)` : ""}. Hutang gaji yang diakui saat disetujui dilunasi dari rekening ini.</p>
                  <Submit className="btn-success">Bayar & bukukan</Submit>
                </ModalForm>
              </Modal>
            )}
          </>
        }
      />
      {changed.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <b>Ada koreksi absensi setelah gaji ini disetujui.</b> Slip yang sudah disetujui tidak berubah otomatis:
          <ul className="mt-1 list-disc pl-5">{changed.map((c) => <li key={c.name}>{c.name}: Alpa di slip {c.was} hari, sekarang {c.now} hari</li>)}</ul>
          {p.status === "DISETUJUI" ? "Bila perlu disesuaikan, Batalkan persetujuan lalu Hitung ulang sebelum dibayar." : "Gaji sudah dibayar; selesaikan selisihnya di periode berikutnya (bonus/potongan)."}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Status" value={<Badge tone={p.status === "DIBAYAR" ? "green" : p.status === "DISETUJUI" ? "blue" : "amber"}>{p.status}</Badge>} hint={p.approvedBy ? `Disetujui ${p.approvedBy}` : undefined} />
        {p.kind === "BULANAN" ? <Stat label="Gaji pokok" value={idr(sum("baseSalary"))} hint={Number(p.payslips.reduce((t, x) => t + Number(x.alpaDeduction), 0)) > 0 ? `Potongan Alpa ${idr(p.payslips.reduce((t, x) => t + Number(x.alpaDeduction), 0))}` : undefined} /> : p.kind === "TUNJANGAN" ? <Stat label="Tunjangan" value={idr(sum("allowance"))} /> : <Stat label="Upah harian" value={idr(sum("dailyWage"))} />}
        <Stat label="Upah borongan" value={idr(sum("pieceWage"))} />
        <Stat label="Transport assembling" value={idr(sum("transport"))} />
        <Stat label="Total" value={idr(sum("total"))} tone="blue" hint={journal ? `Jurnal ${journal.number} · ${fmtDateTime(p.paidAt)}` : undefined} />
      </div>
      {p.payslips.length === 0 ? <Empty title="Belum ada slip" hint={p.kind === "BULANAN" ? "Belum ada karyawan bulanan yang siklusnya cocok dengan periode ini." : "Klik Hitung ulang untuk menghitung dari absensi tervalidasi, hasil borongan, dan transport."} /> : (
        <Card title="Slip gaji">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>Karyawan</th><th>Divisi</th><th className="num">Hadir</th>{p.kind === "BULANAN" && <><th className="num">Libur</th><th className="num">Alpa</th><th className="num">Gaji pokok</th></>}<th className="num">Harian</th><th className="num">Borongan</th>{p.kind === "TUNJANGAN" && <th className="num">Tunjangan</th>}<th className="num">Transport</th><th className="num">Bonus</th><th className="num">Potongan<div className="text-[10px] font-normal normal-case">alpa + lain</div></th><th className="num">Kasbon</th><th className="num">Total</th><th /></tr></thead>
              <tbody>
                {p.payslips.map((s) => (
                  <tr key={s.id}>
                    <td>{s.employee.name}</td><td>{s.employee.division.name}</td><td className="num">{s.daysPresent}</td>{p.kind === "BULANAN" && <><td className="num">{s.offDays}</td><td className={`num ${s.absentDays ? "text-rose-600" : ""}`}>{s.absentDays}{s.lateCount > 0 && <div className="text-xs font-normal text-amber-600">telat {s.lateCount}× · {s.lateMinutes} mnt</div>}</td><td className="num">{idr(s.baseSalary)}</td></>}<td className="num">{idr(s.dailyWage)}</td><td className="num">{idr(s.pieceWage)}</td>{p.kind === "TUNJANGAN" && <td className="num">{idr(s.allowance)}</td>}<td className="num">{idr(s.transport)}</td><td className="num">{idr(s.bonus)}</td><td className="num text-rose-600">{idr(Number(s.deduction) + Number(s.alpaDeduction))}{Number(s.alpaDeduction) > 0 && <div className="text-xs font-normal">Alpa {idr(s.alpaDeduction)}</div>}</td><td className="num text-rose-600">{idr(s.advanceDeduction)}</td><td className="num font-semibold">{idr(s.total)}{s.note && <div className="text-xs font-normal text-slate-400">{s.note}</div>}{s.paidAt && p.status !== "DIBAYAR" && <div className="text-xs font-semibold text-emerald-700">✓ Lunas {fmtDay(s.paidAt)}</div>}</td>
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
