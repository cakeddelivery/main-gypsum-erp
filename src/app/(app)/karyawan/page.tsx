import { requirePerm } from "@/lib/auth";
import { PasswordInput } from "@/components/PasswordInput";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { ROLE_LABEL, ROLES } from "@/lib/rbac";
import { AutoCode, Badge, Empty, FilterBar, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { cancelResign, resignEmployee, saveAccount, saveEmployee } from "./actions";
import { AllowanceFields } from "./AllowanceFields";
import { ActionForm } from "@/components/ActionForm";
import { todayStr } from "@/lib/time";
import type { EmployeeStatus } from "@prisma/client";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Karyawan" };
const WAGE = { BULANAN: "Bulanan (gajian H+7)", HARIAN: "Harian", BORONGAN: "Borongan (per piece, klaim)", CAMPURAN: "Harian + borongan" };

export default async function KaryawanPage({ searchParams }: { searchParams: Promise<{ q?: string; division?: string; status?: string }> }) {
  const user = await requirePerm("employee.view");
  const sp = await searchParams;
  const fixedDiv = user.role === "KAPTEN_DIVISI" ? user.divisionId : null;
  const [employees, divisions] = await Promise.all([
    prisma.employee.findMany({
      where: { ...(fixedDiv ? { divisionId: fixedDiv } : sp.division ? { divisionId: sp.division } : {}), ...(sp.status ? { status: sp.status as EmployeeStatus } : {}), ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { code: { contains: sp.q, mode: "insensitive" } }] } : {}) },
      include: { division: true, user: true, allowances: { where: { active: true }, orderBy: { name: "asc" } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);
  const canManage = user.can("employee.manage");
  // Nominal gaji rahasia: hanya pengelola karyawan & penggajian (bukan kapten/supervisor)
  const canSeePay = canManage || user.can("payroll.manage") || user.can("payroll.approve");
  const canAllowance = user.can("payroll.manage");
  const bpjsDefault = Number((await prisma.setting.findUnique({ where: { key: "bpjs_tk_amount" } }))?.value) || 28400;
  const roles = user.can("users.manage") ? ROLES.filter((r) => r !== "OWNER" || user.role === "OWNER") : (["OPERATOR", "KAPTEN_DIVISI", "PIC_CONTENT", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE"] as const);
  const form = (e?: (typeof employees)[number]) => (
    <ModalForm action={saveEmployee} className="grid grid-cols-2 gap-3">
      {e && <input type="hidden" name="id" value={e.id} />}
      <AutoCode value={e?.code} example="CTK-001" hint="Awalan = kode divisi + nomor urut" />
      <Field label="Nama"><input name="name" defaultValue={e?.name} className="input" required /></Field>
      <Field label="Divisi"><select name="divisionId" defaultValue={e?.divisionId} className="input">{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Status"><select name="status" defaultValue={e?.status ?? "AKTIF"} className="input"><option value="AKTIF">Aktif</option><option value="CUTI">Cuti</option><option value="NONAKTIF">Nonaktif</option></select></Field>
      <Field label="Sistem upah"><select name="wageType" defaultValue={e?.wageType ?? "HARIAN"} className="input">{Object.entries(WAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Gaji bulanan (IDR)" hint="Untuk sistem upah Bulanan"><input name="monthlySalary" inputMode="numeric" defaultValue={e ? Number(e.monthlySalary) : 0} className="input" /></Field>
      <Field label="Upah harian (IDR)" hint="Untuk Harian / Campuran"><input name="dailyRate" inputMode="numeric" defaultValue={e ? Number(e.dailyRate) : 0} className="input" /></Field>
      <Field label="Telepon"><input name="phone" defaultValue={e?.phone ?? ""} className="input" /></Field>
      <Field label="Tanggal masuk" hint="Menentukan siklus & tanggal gajian"><input type="date" name="joinDate" defaultValue={e?.joinDate?.toISOString().slice(0, 10)} className="input" /></Field>
      <div className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="bpjsTk" defaultChecked={e?.bpjsTk} /> Ikut BPJS Ketenagakerjaan <span className="text-xs font-normal text-slate-500">(dibayar perusahaan, tidak memotong gaji)</span></label>
        <Field label="Nominal per bulan (Rp)" hint={`Kosongkan = bawaan ${idr(bpjsDefault)}`} className="mt-2"><input name="bpjsTkAmount" inputMode="numeric" defaultValue={e?.bpjsTkAmount != null ? Number(e.bpjsTkAmount) : ""} placeholder={String(bpjsDefault)} className="input" /></Field>
      </div>
      {canAllowance && <AllowanceFields initial={(e?.allowances ?? []).map((a) => ({ id: a.id, name: a.name, amount: Number(a.amount) }))} />}
      <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div>
      <PageHeader title="Karyawan" subtitle="Data karyawan, divisi, status, sistem upah, tunjangan, dan akun login" actions={canManage && <Modal trigger="+ Karyawan" title="Karyawan baru">{form()}</Modal>} />
      <FilterBar>
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="Nama / kode" /></Field>
        {!fixedDiv && <Field label="Divisi"><select name="division" defaultValue={sp.division ?? ""} className="input"><option value="">Semua</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="input"><option value="">Semua</option><option value="AKTIF">Aktif</option><option value="CUTI">Cuti</option><option value="NONAKTIF">Nonaktif</option></select></Field>
      </FilterBar>
      {employees.length === 0 ? <Empty /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Kode</th><th>Nama</th><th>Divisi</th><th>Status</th><th>Upah</th><th>Masuk</th><th>Akun</th>{canManage && <th />}</tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.code}</td><td>{e.name}</td><td>{e.division.name}</td>
                  <td><Badge tone={e.status === "AKTIF" ? "green" : e.status === "CUTI" ? "amber" : "gray"}>{e.status}</Badge></td>
                  <td>{WAGE[e.wageType]}{!canSeePay ? null : e.wageType === "BULANAN" ? <div className="text-xs text-slate-400">{idr(e.monthlySalary)}/bulan</div> : Number(e.dailyRate) > 0 && <div className="text-xs text-slate-400">{idr(e.dailyRate)}/hari</div>}{canSeePay && e.bpjsTk && <div className="text-xs text-sky-600">BPJS TK {idr(e.bpjsTkAmount != null ? e.bpjsTkAmount : bpjsDefault)}/bulan (perusahaan)</div>}{canSeePay && e.allowances.length > 0 && <div className="text-xs text-slate-400">+ tunjangan {idr(e.allowances.reduce((t, a) => t + Number(a.amount), 0))}/bulan</div>}</td>
                  <td>{fmtDay(e.joinDate)}{e.resignDate && <div className="text-xs text-rose-600">Resign {fmtDay(e.resignDate)}</div>}</td>
                  <td>{e.user ? <span className="text-xs">{e.user.username} · {ROLE_LABEL[e.user.role]}{!e.user.active && " (nonaktif)"}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                  {canManage && (
                    <td><div className="flex gap-1">
                      <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah karyawan">{form(e)}</Modal>
                      {!e.resignDate && e.status !== "NONAKTIF" && (
                        <Modal trigger="Resign" triggerClass="btn-secondary btn-sm text-rose-700" title={`Resign ${e.name}`}>
                          <ModalForm action={resignEmployee} className="space-y-3">
                            <input type="hidden" name="id" value={e.id} />
                            <Field label="Tanggal resign" hint="Hari terakhir bekerja. Resign sebelum tanggal gajian = slip siklus itu Rp0."><input type="date" name="resignDate" defaultValue={todayStr()} className="input" required /></Field>
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" required className="mt-1" /> <span>Saya yakin {e.name} resign. Bila tanggalnya hari ini atau sudah lewat, status jadi Nonaktif dan akun login dimatikan.</span></label>
                            <Submit className="btn-danger">Simpan resign</Submit>
                          </ModalForm>
                        </Modal>
                      )}
                      {e.resignDate && (
                        <ActionForm action={cancelResign} confirm={`Batalkan resign ${e.name}? Status kembali Aktif.`}><input type="hidden" name="id" value={e.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Batal resign</Submit></ActionForm>
                      )}
                      <Modal trigger="Akun" triggerClass="btn-secondary btn-sm" title={`Akun login ${e.name}`}>
                        <ModalForm action={saveAccount} className="space-y-3">
                          <input type="hidden" name="employeeId" value={e.id} />
                          <Field label="Username"><input name="username" defaultValue={e.user?.username ?? e.name.split(" ")[0].toLowerCase()} className="input" autoCapitalize="none" required /></Field>
                          <Field label="Role"><select name="role" defaultValue={e.user?.role ?? "OPERATOR"} className="input">{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
                          <Field label={e.user ? "Password baru (kosongkan bila tidak diubah)" : "Password"} hint="Minimal 8 karakter"><PasswordInput name="password" autoComplete="new-password" className="input" /></Field>
                          {e.user && <Field label="Status akun"><select name="active" defaultValue={e.user.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
                          <Submit>Simpan akun</Submit>
                        </ModalForm>
                      </Modal>
                    </div></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
