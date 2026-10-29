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
import { changeOwnPassword } from "./actions";

export const metadata = { title: "Profil" };

export default async function ProfilPage() {
  const me = await requireUser();
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { employee: { include: { division: true } }, division: true, telegram: true } });
  const division = u.division?.name ?? u.employee?.division.name;
  const rows: [string, React.ReactNode][] = [
    ["Nama", u.name],
    ["Username", <span key="u" className="font-mono">{u.username}</span>],
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
          <Modal trigger="Ganti password" title="Ganti password">
            <ModalForm action={changeOwnPassword} className="space-y-3">
              <Field label="Password lama"><input type="password" name="current" autoComplete="current-password" className="input" required /></Field>
              <Field label="Password baru" hint="Minimal 8 karakter"><input type="password" name="password" autoComplete="new-password" minLength={8} className="input" required /></Field>
              <Field label="Ulangi password baru"><input type="password" name="confirm" autoComplete="new-password" minLength={8} className="input" required /></Field>
              <Submit>Simpan password</Submit>
            </ModalForm>
          </Modal>
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
      </div>
    </div>
  );
}

