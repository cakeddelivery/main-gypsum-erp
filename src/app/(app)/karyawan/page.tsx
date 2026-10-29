import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { ROLE_LABEL, ROLES } from "@/lib/rbac";
import { Badge, Empty, FilterBar, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { saveAccount, saveEmployee } from "./actions";
import type { EmployeeStatus } from "@prisma/client";

export const metadata = { title: "Karyawan" };
const WAGE = { BULANAN: "Bulanan (gajian H+7)", HARIAN: "Harian", BORONGAN: "Borongan (per piece, klaim)", CAMPURAN: "Harian + borongan" };

export default async function KaryawanPage({ searchParams }: { searchParams: Promise<{ q?: string; division?: string; status?: string }> }) {
  const user = await requirePerm("employee.view");
  const sp = await searchParams;
  const fixedDiv = user.role === "KAPTEN_DIVISI" ? user.divisionId : null;
  const [employees, divisions] = await Promise.all([
    prisma.employee.findMany({
      where: { ...(fixedDiv ? { divisionId: fixedDiv } : sp.division ? { divisionId: sp.division } : {}), ...(sp.status ? { status: sp.status as EmployeeStatus } : {}), ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { code: { contains: sp.q, mode: "insensitive" } }] } : {}) },
      include: { division: true, user: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);
  const canManage = user.can("employee.manage");
  const roles = user.can("users.manage") ? ROLES.filter((r) => r !== "OWNER" || user.role === "OWNER") : (["OPERATOR", "KAPTEN_DIVISI", "PIC_CONTENT", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE"] as const);
  const form = (e?: (typeof employees)[number]) => (
    <ModalForm action={saveEmployee} className="grid grid-cols-2 gap-3">
      {e && <input type="hidden" name="id" value={e.id} />}
      <Field label="Kode"><input name="code" defaultValue={e?.code} className="input" required /></Field>
      <Field label="Nama"><input name="name" defaultValue={e?.name} className="input" required /></Field>
      <Field label="Divisi"><select name="divisionId" defaultValue={e?.divisionId} className="input">{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Jabatan"><input name="position" defaultValue={e?.position} className="input" required /></Field>
      <Field label="Status"><select name="status" defaultValue={e?.status ?? "AKTIF"} className="input"><option value="AKTIF">Aktif</option><option value="CUTI">Cuti</option><option value="NONAKTIF">Nonaktif</option></select></Field>
      <Field label="Sistem upah"><select name="wageType" defaultValue={e?.wageType ?? "HARIAN"} className="input">{Object.entries(WAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Gaji bulanan (IDR)" hint="Untuk sistem upah Bulanan"><input name="monthlySalary" inputMode="numeric" defaultValue={e ? Number(e.monthlySalary) : 0} className="input" /></Field>
      <Field label="Upah harian (IDR)" hint="Untuk Harian / Campuran"><input name="dailyRate" inputMode="numeric" defaultValue={e ? Number(e.dailyRate) : 0} className="input" /></Field>
      <Field label="Telepon"><input name="phone" defaultValue={e?.phone ?? ""} className="input" /></Field>
      <Field label="Tanggal masuk" hint="Menentukan siklus & tanggal gajian"><input type="date" name="joinDate" defaultValue={e?.joinDate?.toISOString().slice(0, 10)} className="input" /></Field>
      <Field label="Tanggal resign" hint="Resign sebelum gajian = tidak digaji"><input type="date" name="resignDate" defaultValue={e?.resignDate?.toISOString().slice(0, 10)} className="input" /></Field>
      <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div>
      <PageHeader title="Karyawan" subtitle="Data karyawan, divisi, jabatan, status, sistem upah, dan akun login" actions={canManage && <Modal trigger="+ Karyawan" title="Karyawan baru">{form()}</Modal>} />
      <FilterBar>
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="Nama / kode" /></Field>
        {!fixedDiv && <Field label="Divisi"><select name="division" defaultValue={sp.division ?? ""} className="input"><option value="">Semua</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="input"><option value="">Semua</option><option value="AKTIF">Aktif</option><option value="CUTI">Cuti</option><option value="NONAKTIF">Nonaktif</option></select></Field>
      </FilterBar>
      {employees.length === 0 ? <Empty /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Kode</th><th>Nama</th><th>Divisi</th><th>Jabatan</th><th>Status</th><th>Upah</th><th>Masuk</th><th>Akun</th>{canManage && <th />}</tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.code}</td><td>{e.name}</td><td>{e.division.name}</td><td>{e.position}</td>
                  <td><Badge tone={e.status === "AKTIF" ? "green" : e.status === "CUTI" ? "amber" : "gray"}>{e.status}</Badge></td>
                  <td>{WAGE[e.wageType]}{e.wageType === "BULANAN" ? <div className="text-xs text-slate-400">{idr(e.monthlySalary)}/bulan</div> : Number(e.dailyRate) > 0 && <div className="text-xs text-slate-400">{idr(e.dailyRate)}/hari</div>}</td>
                  <td>{fmtDay(e.joinDate)}{e.resignDate && <div className="text-xs text-rose-600">Resign {fmtDay(e.resignDate)}</div>}</td>
                  <td>{e.user ? <span className="text-xs">{e.user.username} · {ROLE_LABEL[e.user.role]}{!e.user.active && " (nonaktif)"}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                  {canManage && (
                    <td className="flex gap-1">
                      <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah karyawan">{form(e)}</Modal>
                      <Modal trigger="Akun" triggerClass="btn-secondary btn-sm" title={`Akun login ${e.name}`}>
                        <ModalForm action={saveAccount} className="space-y-3">
                          <input type="hidden" name="employeeId" value={e.id} />
                          <Field label="Username"><input name="username" defaultValue={e.user?.username ?? e.name.split(" ")[0].toLowerCase()} className="input" autoCapitalize="none" required /></Field>
                          <Field label="Role"><select name="role" defaultValue={e.user?.role ?? "OPERATOR"} className="input">{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
                          <Field label={e.user ? "Password baru (kosongkan bila tidak diubah)" : "Password"} hint="Minimal 8 karakter"><input name="password" type="password" autoComplete="new-password" className="input" /></Field>
                          {e.user && <Field label="Status akun"><select name="active" defaultValue={e.user.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
                          <Submit>Simpan akun</Submit>
                        </ModalForm>
                      </Modal>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
