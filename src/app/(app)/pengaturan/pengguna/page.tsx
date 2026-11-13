import { requirePerm } from "@/lib/auth";
import { PasswordInput } from "@/components/PasswordInput";
import { prisma } from "@/lib/db";
import { ALL_PERMISSIONS, MENU_GROUPS, PERMISSIONS, RESTRICTED, ROLE_LABEL, ROLES, effectivePermissions } from "@/lib/rbac";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Field, PageHeader, Tabs } from "@/components/ui";
import { ClientTabs } from "@/components/ClientTabs";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveMatrix, saveMenuAccess, saveUser } from "../actions";
import type { Role } from "@prisma/client";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Pengguna & Hak Akses" };

export default async function PenggunaPage({ searchParams }: { searchParams: Promise<{ tab?: string; role?: string }> }) {
  const me = await requirePerm("users.manage");
  const sp = await searchParams;
  const tab = sp.tab === "akses" || sp.tab === "menu" ? sp.tab : "pengguna";
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
      <Field label="Email (opsional)" hint="Untuk lupa password & login dengan Google" className="col-span-2"><input type="email" name="email" defaultValue={u?.email ?? ""} className="input" autoCapitalize="none" autoComplete="off" placeholder="nama@gmail.com" /></Field>
      <Field label={u ? "Reset password (opsional)" : "Password"} hint="Minimal 8 karakter" className="col-span-2"><PasswordInput name="password" autoComplete="new-password" className="input" /></Field>
      {u && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={u.active} /> Aktif</label>}
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  const role = (ROLES.includes(sp.role as Role) ? sp.role : "FINANCE") as Role;
  const groups = Array.from(new Set(ALL_PERMISSIONS.map((p) => p.split(".")[0])));
  // Semua tab dikirim sekaligus dan ditukar di HP (tanpa menunggu server), lihat ClientTabs
  // Matriks hak akses cukup untuk role yang dipilih (10 matriks sekaligus terlalu berat untuk HP)
  const rolePanels = Object.fromEntries([role].map((r) => [r, (
          <Card title={`Hak akses ${ROLE_LABEL[r]}`}>
            {r === "OWNER" ? <p className="text-sm text-slate-500">Owner selalu memiliki semua hak akses, termasuk menu pengelolaan bot Telegram (khusus Owner).</p> : (
              <ActionForm action={saveMatrix}>
                <input type="hidden" name="role" value={r} />
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {groups.map((g) => (
                    <fieldset key={g} className="rounded-lg border border-slate-200 p-3">
                      <legend className="px-1 text-xs font-semibold uppercase text-slate-500">{g}</legend>
                      {ALL_PERMISSIONS.filter((p) => p.startsWith(g + ".")).map((p) => (
                        <label key={p} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" name="perm" value={p} defaultChecked={effectivePermissions(r, overrides).has(p)} disabled={p === "telegram.manage" || !!RESTRICTED[p] && !RESTRICTED[p]!.includes(r)} /> {PERMISSIONS[p]}</label>
                      ))}
                    </fieldset>
                  ))}
                </div>
                <div className="mt-4"><Submit>Simpan hak akses</Submit></div>
              </ActionForm>
            )}
          </Card>
  )]));
  return (
    <div className="space-y-4">
      <PageHeader title="Pengguna & hak akses" subtitle="RBAC sampai tingkat menu dan tindakan" />
      <ClientTabs
        initial={tab}
        tabs={[{ key: "pengguna", label: "Pengguna", count: users.length }, { key: "menu", label: "Akses menu" }, { key: "akses", label: "Hak akses detail" }]}
        actions={{ pengguna: <Modal trigger="+ Pengguna" title="Pengguna baru">{form()}</Modal> }}
        panels={{
          pengguna: (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>Karyawan/Divisi</th><th>Login terakhir</th><th>Status</th><th /></tr></thead>
            <tbody>{users.map((u) => <tr key={u.id}><td className="font-mono text-xs">{u.username}</td><td>{u.name}{u.email && <div className="text-xs text-slate-500">{u.email}</div>}</td><td><Badge tone="blue">{ROLE_LABEL[u.role]}</Badge></td><td className="text-xs">{u.employee?.code}{u.division && ` · ${u.division.name}`}</td><td className="text-xs">{fmtDateTime(u.lastLoginAt)}</td><td>{u.active ? (u.lockedUntil && u.lockedUntil > new Date() ? <Badge tone="red">Terkunci</Badge> : <Badge tone="green">Aktif</Badge>) : <Badge>Nonaktif</Badge>}</td><td>{(u.role !== "OWNER" || me.role === "OWNER") && <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${u.username}`}>{form(u)}</Modal>}</td></tr>)}</tbody>
          </table></Paged>
        </div>
          ),
          menu: (
        <Card title="Akses menu per role">
          <p className="mb-3 text-sm text-slate-500">Centang = menu tampil dan bisa dibuka. Menu yang dimatikan juga ditolak di server (tidak bisa dibuka lewat alamat langsung atau bot). Owner selalu punya semua akses. Pengaturan halus per tindakan ada di tab Hak akses detail.</p>
          <ActionForm action={saveMenuAccess}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Menu</th><th className="text-center">Owner</th>{ROLES.filter((r) => r !== "OWNER").map((r) => <th key={r} className="text-center text-xs">{ROLE_LABEL[r]}</th>)}</tr></thead>
                <tbody>
                  {MENU_GROUPS.map((g) => (
                    <tr key={g.key}>
                      <td className="font-medium">{g.label}</td>
                      <td className="text-center"><input type="checkbox" checked disabled aria-label={`${g.label} Owner`} /></td>
                      {ROLES.filter((r) => r !== "OWNER").map((r) => {
                        const on = g.perms.some((p) => effectivePermissions(r, overrides).has(p));
                        return <td key={r} className="text-center"><input type="checkbox" name={`menu.${r}`} value={g.key} defaultChecked={on} aria-label={`${g.label} ${ROLE_LABEL[r]}`} /></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4"><Submit>Simpan akses menu</Submit></div>
          </ActionForm>
        </Card>
          ),
          akses: (
            <>
              <Tabs current={role} tabs={ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r], href: `?tab=akses&role=${r}` }))} />
              {rolePanels[role]}
            </>
          ),
        }}
      />
    </div>
  );
}
