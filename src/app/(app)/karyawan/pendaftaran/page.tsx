import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDay, fmtDateTime, todayStr } from "@/lib/time";
import { ROLE_LABEL, ROLES } from "@/lib/rbac";
import { inviteLink } from "@/lib/registration";
import { Badge, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { CopyButton } from "@/components/CopyButton";
import { Paged } from "@/components/Paged";
import { approveRegistrationAction, createInviteAction, disableInviteAction, rejectRegistrationAction } from "../actions";

export const metadata = { title: "Pendaftaran Karyawan" };

const WAGE = { BULANAN: "Bulanan (gajian H+7)", HARIAN: "Harian", BORONGAN: "Borongan (per piece, klaim)", CAMPURAN: "Harian + borongan" };
const FIELD_ROLES = ["OPERATOR", "KAPTEN_DIVISI", "PIC_CONTENT", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE"] as const;
const STATUS_TONE = { MENUNGGU: "amber", DISETUJUI: "green", DITOLAK: "red" } as const;

/** Verifikasi pendaftaran karyawan dari form publik /daftar + kelola tautan undangan */
export default async function PendaftaranPage() {
  const user = await requirePerm("employee.manage");
  const [regs, invites, divisions, bpjsSetting] = await Promise.all([
    prisma.employeeRegistration.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.registrationInvite.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { _count: { select: { registrations: true } } } }),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.setting.findUnique({ where: { key: "bpjs_tk_amount" } }),
  ]);
  const bpjsDefault = Number(bpjsSetting?.value) || 28400;
  // Rekening gaji: data pribadi, hanya Owner & Finance
  const seeBank = user.role === "OWNER" || user.role === "FINANCE";
  const roles = user.can("users.manage") ? ROLES.filter((r) => r !== "OWNER") : FIELD_ROLES;
  const pending = regs.filter((r) => r.status === "MENUNGGU");
  const done = regs.filter((r) => r.status !== "MENUNGGU");
  const now = new Date();
  const employees = await prisma.employee.findMany({ where: { id: { in: done.map((r) => r.employeeId).filter((x): x is string => !!x) } }, select: { id: true, code: true } });
  const age = (d: Date) => Math.floor((now.getTime() - d.getTime()) / (365.25 * 86_400_000));

  return (
    <div className="space-y-5">
      <PageHeader title="Pendaftaran karyawan" subtitle="Calon karyawan mengisi data sendiri lewat tautan undangan. Owner memverifikasi, mengisi divisi & gaji, lalu menyetujui." />
      <Tabs current="pendaftaran" tabs={[{ key: "karyawan", label: "Karyawan", href: "/karyawan" }, { key: "pendaftaran", label: "Pendaftaran", href: "/karyawan/pendaftaran", count: pending.length }]} />

      <Card title={`Menunggu verifikasi (${pending.length})`}>
        {pending.length === 0 ? <Empty title="Tidak ada pendaftaran baru" hint="Bagikan tautan undangan di bawah ke calon karyawan." /> : (
          <ul className="divide-y divide-slate-100">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p><b>{r.fullName}</b> ({r.nickname}) · <span className="font-mono text-xs">{r.number}</span> · {r.gender === "L" ? "Laki-laki" : "Perempuan"}</p>
                  <p className="text-slate-600">{r.birthPlace}, {fmtDay(r.birthDate)} ({age(r.birthDate)} th) · WA {r.phone} · {r.email}</p>
                  <p className="text-slate-600">{r.address}</p>
                  <p className="text-slate-600">Usulan mulai kerja {fmtDay(r.startDate)} · username <span className="font-mono">{r.username}</span></p>
                  <p className="text-slate-600">Rekening: {seeBank ? <>{r.bankName} {r.bankAccountNo} a.n. {r.bankAccountName}</> : <span className="text-slate-400">hanya terlihat Owner/Finance</span>}</p>
                  <p className="text-xs text-slate-400">Dikirim {fmtDateTime(r.createdAt)}</p>
                </div>
                <div className="flex gap-1">
                  <Modal trigger="Setujui" triggerClass="btn-success btn-sm" title={`Setujui ${r.fullName}`}>
                    <ModalForm action={approveRegistrationAction} className="grid grid-cols-2 gap-3">
                      <input type="hidden" name="id" value={r.id} />
                      <Field label="Divisi"><select name="divisionId" className="input" required defaultValue=""><option value="" disabled>— pilih —</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
                      <Field label="Role akun"><select name="role" className="input" defaultValue="OPERATOR">{roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select></Field>
                      <Field label="Sistem upah"><select name="wageType" className="input" defaultValue="HARIAN">{Object.entries(WAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                      <Field label="Tanggal masuk" hint="Menentukan siklus & tanggal gajian"><input type="date" name="joinDate" className="input" required defaultValue={r.startDate.toISOString().slice(0, 10)} /></Field>
                      <Field label="Gaji bulanan (IDR)" hint="Untuk sistem upah Bulanan"><input name="monthlySalary" inputMode="numeric" className="input" defaultValue="0" /></Field>
                      <Field label="Upah harian (IDR)" hint="Untuk Harian / Campuran"><input name="dailyRate" inputMode="numeric" className="input" defaultValue="0" /></Field>
                      <div className="col-span-2 rounded-xl border border-slate-200 p-3">
                        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="bpjsTk" /> Ikut BPJS Ketenagakerjaan <span className="text-xs font-normal text-slate-500">(dibayar perusahaan)</span></label>
                        <Field label="Nominal per bulan (Rp)" hint={`Kosongkan = bawaan Rp ${bpjsDefault.toLocaleString("id-ID")}`} className="mt-2"><input name="bpjsTkAmount" inputMode="numeric" className="input" placeholder={String(bpjsDefault)} /></Field>
                      </div>
                      <p className="col-span-2 text-xs text-slate-500">Kode karyawan dibuat otomatis. Akun login {r.username} langsung aktif dengan password yang dibuat pendaftar. Tunjangan bisa ditambahkan lewat Ubah karyawan.</p>
                      <div className="col-span-2"><Submit>Setujui & buat akun</Submit></div>
                    </ModalForm>
                  </Modal>
                  <Modal trigger="Tolak" triggerClass="btn-secondary btn-sm" title={`Tolak ${r.fullName}`}>
                    <ModalForm action={rejectRegistrationAction} className="space-y-3">
                      <input type="hidden" name="id" value={r.id} />
                      <Field label="Alasan (tercatat di audit)"><input name="reason" className="input" required /></Field>
                      <Submit className="btn-danger">Tolak pendaftaran</Submit>
                    </ModalForm>
                  </Modal>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Tautan undangan" actions={
        <Modal trigger="+ Tautan undangan" title="Tautan undangan baru">
          <ModalForm action={createInviteAction} className="space-y-3">
            <Field label="Berlaku (hari)" hint="1–90 hari. Bisa dimatikan kapan saja."><input name="days" inputMode="numeric" defaultValue="7" className="input" required /></Field>
            <Field label="Catatan (opsional)"><input name="note" className="input" placeholder="cth: rekrutmen divisi Packing" /></Field>
            <Submit>Buat tautan</Submit>
          </ModalForm>
        </Modal>
      }>
        {invites.length === 0 ? <p className="text-sm text-slate-500">Belum ada tautan. Buat tautan lalu kirim ke calon karyawan lewat WhatsApp.</p> : (
          <div className="table-wrap"><Paged><table className="tbl">
            <thead><tr><th>Catatan</th><th>Berlaku sampai</th><th className="num">Pendaftar</th><th>Status</th><th /></tr></thead>
            <tbody>{invites.map((i) => {
              const live = i.active && i.expiresAt > now;
              return (
                <tr key={i.id} className={live ? "" : "opacity-60"}>
                  <td>{i.note ?? "-"}<div className="text-xs text-slate-400">dibuat {i.createdBy} · {fmtDay(i.createdAt)}</div></td>
                  <td>{fmtDateTime(i.expiresAt)}</td>
                  <td className="num">{i._count.registrations}</td>
                  <td>{live ? <Badge tone="green">Aktif</Badge> : <Badge>{i.active ? "Kedaluwarsa" : "Dimatikan"}</Badge>}</td>
                  <td>{live && <div className="flex gap-1">
                    <CopyButton text={inviteLink(i.code)} />
                    <ActionForm action={disableInviteAction} confirm="Matikan tautan ini? Pendaftar baru tidak bisa memakainya lagi."><input type="hidden" name="id" value={i.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Matikan</Submit></ActionForm>
                  </div>}</td>
                </tr>
              );
            })}</tbody>
          </table></Paged></div>
        )}
      </Card>

      {done.length > 0 && (
        <Card title="Riwayat pendaftaran">
          <div className="table-wrap"><Paged><table className="tbl">
            <thead><tr><th>No.</th><th>Nama</th><th>Status</th><th>Diproses</th><th>Keterangan</th></tr></thead>
            <tbody>{done.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.number}</td>
                <td>{r.fullName}<div className="text-xs text-slate-400">{r.username}</div></td>
                <td><Badge tone={STATUS_TONE[r.status]}>{r.status === "DISETUJUI" ? "Disetujui" : "Ditolak"}</Badge></td>
                <td className="text-xs">{r.decidedBy}{r.decidedAt && <div className="text-slate-400">{fmtDateTime(r.decidedAt)}</div>}</td>
                <td className="text-xs">{r.status === "DITOLAK" ? r.rejectReason : `Karyawan ${employees.find((e) => e.id === r.employeeId)?.code ?? "-"}`}</td>
              </tr>
            ))}</tbody>
          </table></Paged></div>
        </Card>
      )}
      <p className="text-xs text-slate-400">Hari ini {todayStr()}. Pendaftaran yang disetujui/ditolak tetap tersimpan sebagai riwayat.</p>
    </div>
  );
}
