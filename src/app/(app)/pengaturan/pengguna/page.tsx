import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_LABEL, ROLES, effectivePermissions } from "@/lib/rbac";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveMatrix, saveUser } from "../actions";
import type { Role } from "@prisma/client";

export const metadata = { title: "Pengguna & Hak Akses" };

export default async function PenggunaPage({ searchParams }: { searchParams: Promise<{ tab?: string; role?: string }> }) {
  const me = await requirePerm("users.manage");
  const sp = await searchParams;
  const tab = sp.tab === "akses" ? "akses" : "pengguna";
  const [users, divisions, overrides] = await Promise.all([
    prisma.user.findMany({ include: { employee: true, division: true }, orderBy: [{ role: "asc" }, { name: "asc" }] }),
    prisma.division.findMany({ where: { active: true } }),
    prisma.rolePermission.findMany(),
  ]);
  const roles = ROLES.filter((r) => r !== "OWNER" || me.role === "OWNER");
  const form = (u?: (typeof users)[number]) => (
    <ModalForm action={saveUser} className="grid grid-cols-2 gap-3">
      {u && <input type="hidden" name="id" value={u.id} />}
      <Field label="Username"><input name="username" defaultValue={u?.username} className="input" autoCapitalize="none" required /></Field>
      <Field label="Nama"><input name="name" defaultValue={u?.name} className="input" required /></Field>
      <Field label="Role"><select name="role" defaultValue={u?.role ?? "ADMIN"} className="input">{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
      <Field label="Divisi (Kapten)"><select name="divisionId" defaultValue={u?.divisionId ?? ""} className="input"><option value="">—</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label={u ? "Reset password (opsional)" : "Password"} hint="Minimal 8 karakter" className="col-span-2"><input type="password" name="password" autoComplete="new-password" className="input" /></Field>
      {u && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={u.active} /> Aktif</label>}
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  const role = (ROLES.includes(sp.role as Role) ? sp.role : "FINANCE") as Role;
  const eff = effectivePermissions(role, overrides);
  const groups = Array.from(new Set(ALL_PERMISSIONS.map((p) => p.split(".")[0])));
  return (
    <div className="space-y-4">
      <PageHeader title="Pengguna & hak akses" subtitle="RBAC sampai tingkat menu dan tindakan" actions={tab === "pengguna" && <Modal trigger="+ Pengguna" title="Pengguna baru">{form()}</Modal>} />
      <Tabs current={tab} tabs={[{ key: "pengguna", label: "Pengguna", href: "?tab=pengguna", count: users.length }, { key: "akses", label: "Matriks hak akses", href: "?tab=akses" }]} />
      {tab === "pengguna" ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>Karyawan/Divisi</th><th>Login terakhir</th><th>Status</th><th /></tr></thead>
            <tbody>{users.map((u) => <tr key={u.id}><td className="font-mono text-xs">{u.username}</td><td>{u.name}</td><td><Badge tone="blue">{ROLE_LABEL[u.role]}</Badge></td><td className="text-xs">{u.employee?.code}{u.division && ` · ${u.division.name}`}</td><td className="text-xs">{fmtDateTime(u.lastLoginAt)}</td><td>{u.active ? (u.lockedUntil && u.lockedUntil > new Date() ? <Badge tone="red">Terkunci</Badge> : <Badge tone="green">Aktif</Badge>) : <Badge>Nonaktif</Badge>}</td><td>{(u.role !== "OWNER" || me.role === "OWNER") && <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${u.username}`}>{form(u)}</Modal>}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <>
          <Tabs current={role} tabs={ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r], href: `?tab=akses&role=${r}` }))} />
          <Card title={`Hak akses ${ROLE_LABEL[role]}`}>
            {role === "OWNER" ? <p className="text-sm text-slate-500">Owner selalu memiliki semua hak akses, termasuk menu pengelolaan bot Telegram (khusus Owner).</p> : (
              <ActionForm action={saveMatrix}>
                <input type="hidden" name="role" value={role} />
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {groups.map((g) => (
                    <fieldset key={g} className="rounded-lg border border-slate-200 p-3">
                      <legend className="px-1 text-xs font-semibold uppercase text-slate-500">{g}</legend>
                      {ALL_PERMISSIONS.filter((p) => p.startsWith(g + ".")).map((p) => (
                        <label key={p} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" name="perm" value={p} defaultChecked={eff.has(p)} disabled={p === "telegram.manage"} /> {PERMISSIONS[p]}</label>
                      ))}
                    </fieldset>
                  ))}
                </div>
                <div className="mt-4"><Submit>Simpan hak akses</Submit></div>
              </ActionForm>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
