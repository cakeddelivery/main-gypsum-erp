import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { todayStr } from "@/lib/time";
import { allowanceCode, allowancePayDate } from "@/lib/payroll";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { deleteAllowance, generateAllowance, saveAllowance } from "../actions";

export const metadata = { title: "Tunjangan Karyawan" };

export default async function TunjanganPage() {
  const user = await requirePerm("payroll.view");
  const [rows, employees, payday] = await Promise.all([
    prisma.employeeAllowance.findMany({ include: { employee: true }, orderBy: [{ employee: { name: "asc" } }, { name: "asc" }] }),
    prisma.employee.findMany({ where: { status: { not: "NONAKTIF" } }, orderBy: { name: "asc" } }),
    prisma.setting.findUnique({ where: { key: "allowance_payday" } }).then((s) => Number(s?.value) || 15),
  ]);
  const can = user.can("payroll.manage");
  const active = rows.filter((r) => r.active && r.employee.status !== "NONAKTIF");
  const monthly = active.reduce((s, r) => s + Number(r.amount), 0);
  // Satu slip tunjangan per tanggal bayar per bulan
  const ym = todayStr().slice(0, 7);
  const dates = [...new Set(active.map((r) => allowancePayDate(ym, r.payDay)))].sort();
  const periods = await prisma.payrollPeriod.findMany({ where: { code: { in: dates.map(allowanceCode) } } });
  const due = dates.filter((d) => d <= todayStr() && !periods.some((p) => p.code === allowanceCode(d)));
  const form = (r?: (typeof rows)[number]) => (
    <ModalForm action={saveAllowance} className="space-y-3">
      {r ? <input type="hidden" name="id" value={r.id} /> : (
        <Field label="Karyawan"><select name="employeeId" className="input">{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      )}
      <Field label="Nama tunjangan" hint="mis. Tunjangan jabatan, makan, kehadiran"><input name="name" defaultValue={r?.name} className="input" required /></Field>
      <Field label="Nominal per bulan (IDR)"><input name="amount" inputMode="numeric" defaultValue={r ? Number(r.amount) : ""} className="input" required /></Field>
      <Field label="Tanggal bayar tiap bulan (1–31)" hint="29–31 dibayar di akhir bulan pada bulan yang lebih pendek"><input name="payDay" inputMode="numeric" defaultValue={r?.payDay ?? payday} className="input" required /></Field>
      {r && <label className="flex gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={r.active} /> Aktif</label>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tunjangan karyawan"
        subtitle="Hanya untuk karyawan tertentu. Slip tunjangan dibuat otomatis pada tanggal bayar masing-masing tunjangan (bawaan tgl 15)."
        actions={
          <>
            {can && due.length > 0 && <ActionForm action={generateAllowance}><Submit className="btn-secondary" pendingText="Membuat…">Buat slip yang jatuh tempo</Submit></ActionForm>}
            {can && <Modal trigger="+ Tunjangan" title="Tunjangan baru">{form()}</Modal>}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total tunjangan per bulan" value={idr(monthly)} />
        <Stat label="Karyawan penerima" value={new Set(active.map((r) => r.employeeId)).size} />
        <Stat
          label="Slip tunjangan bulan ini"
          value={dates.length ? <span className="flex flex-col gap-0.5 text-sm">{dates.map((d) => { const p = periods.find((x) => x.code === allowanceCode(d)); return <span key={d}>Tgl {Number(d.slice(8))}: {p ? <Link href={`/gaji/${p.id}`} className="underline">{p.code}</Link> : d <= todayStr() ? "belum dibuat" : "menunggu"}</span>; })}</span> : "—"}
        />
      </div>
      {rows.length === 0 ? <Empty title="Belum ada tunjangan" hint="Tambahkan tunjangan untuk karyawan yang berhak. Karyawan lain tidak terpengaruh." /> : (
        <Card title="Daftar tunjangan">
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>Karyawan</th><th>Tunjangan</th><th className="num">Per bulan</th><th>Tgl bayar</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                    <td>{r.employee.name}</td><td>{r.name}</td><td className="num">{idr(r.amount)}</td><td>tgl {r.payDay}</td>
                    <td>{r.active ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</td>
                    <td className="whitespace-nowrap">{can && (
                      <div className="flex gap-2">
                        <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah tunjangan">{form(r)}</Modal>
                        <ActionForm action={deleteAllowance}><input type="hidden" name="id" value={r.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>
                      </div>
                    )}</td>
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
