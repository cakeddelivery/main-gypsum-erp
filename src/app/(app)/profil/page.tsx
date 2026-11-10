import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/rbac";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { ThemeToggle } from "@/components/ThemeToggle";
import { initials } from "@/lib/initials";
import { InstallAppCard } from "@/components/Pwa";
import { PasswordInput } from "@/components/PasswordInput";
import { changeOwnPassword, saveOwnEmail } from "./actions";

export const metadata = { title: "Profil" };

export default async function ProfilPage() {
  const me = await requireUser();
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { employee: { include: { division: true } }, division: true, telegram: true } });
  const division = u.division?.name ?? u.employee?.division.name;
  const rows: [string, React.ReactNode][] = [
    ["Nama", u.name],
    ["Username", <span key="u" className="font-mono">{u.username}</span>],
    ["Email", u.email ?? "Belum diisi"],
    ["Role", <Badge key="r" tone="blue">{ROLE_LABEL[u.role]}</Badge>],
    ["Divisi", division],
    ["Data karyawan", u.employee ? `${u.employee.code} · ${u.employee.name}` : undefined],
    ["Telegram", u.telegram.length ? <Badge key="t" tone="green">Terhubung</Badge> : "Belum terhubung"],
    ["Login terakhir", fmtDateTime(u.lastLoginAt)],
    ["Akun dibuat", fmtDateTime(u.createdAt)],
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Profil"
        subtitle="Data akun yang sedang login"
        actions={
          <div className="flex flex-wrap gap-2">
          <Modal trigger={u.email ? "Ubah email" : "Isi email"} triggerClass="btn-secondary" title="Email akun">
            <ModalForm action={saveOwnEmail} className="space-y-3">
              <p className="text-xs text-slate-500">Email dipakai untuk menerima link lupa password dan untuk tombol &quot;Masuk dengan Google&quot; (email Google harus sama). Kosongkan untuk menghapus.</p>
              <Field label="Email"><input type="email" name="email" defaultValue={u.email ?? ""} className="input" autoCapitalize="none" autoComplete="email" placeholder="nama@gmail.com" /></Field>
              <Field label="Password saat ini"><PasswordInput name="current" autoComplete="current-password" required /></Field>
              <Submit>Simpan email</Submit>
            </ModalForm>
          </Modal>
          <Modal trigger="Ganti password" title="Ganti password">
            <ModalForm action={changeOwnPassword} className="space-y-3">
              <Field label="Password lama"><PasswordInput name="current" autoComplete="current-password" required /></Field>
              <Field label="Password baru" hint="Minimal 8 karakter"><PasswordInput name="password" autoComplete="new-password" minLength={8} className="input" required /></Field>
              <Field label="Ulangi password baru"><PasswordInput name="confirm" autoComplete="new-password" minLength={8} className="input" required /></Field>
              <Submit>Simpan password</Submit>
            </ModalForm>
          </Modal>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Akun">
          <div className="mb-4 flex items-center gap-3">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-600 text-lg font-bold text-white">{initials(u.name)}</span>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-slate-900">{u.name}</div>
              <div className="text-sm text-slate-500">{ROLE_LABEL[u.role]}{division ? ` · ${division}` : ""}</div>
            </div>
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1.5"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-800">{v || "—"}</dd></div>
            ))}
          </dl>
        </Card>
        <Card title="Tampilan">
          <ThemeToggle withLabel />
          <p className="mt-3 text-xs text-slate-500">Untuk mengubah nama, role, atau divisi, hubungi Owner/Admin.</p>
        </Card>
        <InstallAppCard />
      </div>
    </div>
  );
}

