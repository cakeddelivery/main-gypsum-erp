import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { addDays, fmtDay, todayStr } from "@/lib/time";
import { Badge, Empty, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { createPeriod } from "./actions";

export const metadata = { title: "Penggajian" };
const PAY_TONE = { DRAFT: "amber", DISETUJUI: "blue", DIBAYAR: "green" } as const;

export default async function GajiPage() {
  const user = await requirePerm("payroll.view", "payroll.self");
  if (!user.can("payroll.view")) redirect("/gaji/saya");
  const periods = await prisma.payrollPeriod.findMany({ include: { payslips: { select: { total: true } } }, orderBy: { startDate: "desc" }, take: 60 });
  const t = todayStr();
  return (
    <div>
      <PageHeader
        title="Penggajian"
        subtitle="Upah harian & borongan, transport assembling, slip gaji, dan pembayaran"
        actions={
          <>
            {user.employeeId && <Link href="/gaji/saya" className="btn-secondary">Slip saya</Link>}
            {user.can("payroll.manage") && <Link href="/gaji/tarif" className="btn-secondary">Tarif & transport</Link>}
            {user.can("payroll.manage") && (
              <Modal trigger="+ Periode" title="Periode penggajian baru">
                <ModalForm action={createPeriod} className="space-y-3">
                  <Field label="Kode periode"><input name="code" className="input" defaultValue={`GJ-${t}`} required /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Mulai"><input type="date" name="startDate" defaultValue={addDays(t, -6)} className="input" /></Field>
                    <Field label="Selesai"><input type="date" name="endDate" defaultValue={t} className="input" /></Field>
                  </div>
                  <Submit>Buat periode</Submit>
                </ModalForm>
              </Modal>
            )}
          </>
        }
      />
      {periods.length === 0 ? <Empty title="Belum ada periode penggajian" hint="Buat periode (mingguan/bulanan) lalu hitung slip gaji dari absensi & hasil produksi." /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Kode</th><th>Periode</th><th className="num">Karyawan</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.code}</td><td>{fmtDay(p.startDate)} – {fmtDay(p.endDate)}</td><td className="num">{p.payslips.length}</td>
                  <td className="num">{idr(p.payslips.reduce((s, x) => s + Number(x.total), 0))}</td>
                  <td><Badge tone={PAY_TONE[p.status]}>{p.status}</Badge></td>
                  <td><Link href={`/gaji/${p.id}`} className="btn-secondary btn-sm">Buka</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
