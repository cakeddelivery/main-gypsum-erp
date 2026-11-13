import { requirePerm } from "@/lib/auth";
import { PasswordInput } from "@/components/PasswordInput";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { DEFAULT_MATRIX, MENU_GROUPS, PERMISSIONS, RESTRICTED, ROLE_LABEL, ROLES, effectivePermissions, isSensitive, FIELD_ROLES_SENSITIVE } from "@/lib/rbac";
import { RoleAccessEditor, type AccessGroup } from "./RoleAccessEditor";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { SensitiveGuard } from "@/components/SensitiveGuard";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveMatrix, saveUser } from "../actions";
import type { Role } from "@prisma/client";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Pengguna & Hak Akses" };

export default async function PenggunaPage({ searchParams }: { searchParams: Promise<{ tab?: string; role?: string }> }) {
  const me = await requirePerm("users.manage");
  const sp = await searchParams;
  // Akses menu & hak akses detail disatukan (13 Nov 2026); tautan lama ?tab=menu tetap membuka layar hak akses
  const tab = sp.tab === "akses" || sp.tab === "menu" ? "akses" : "pengguna";
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
  // Bawaan: role lapangan pertama (bukan Finance), agar Owner tidak mulai dari role ber-izin keuangan
  const role = (ROLES.includes(sp.role as Role) ? sp.role : "OPERATOR") as Role;
  const eff = effectivePermissions(role, overrides);
  const fieldRole = FIELD_ROLES_SENSITIVE.includes(role);
  const defaults = new Set(DEFAULT_MATRIX[role]);
  const accessGroups: AccessGroup[] = MENU_GROUPS.map((g) => {
    const base = g.perms.filter((p) => defaults.has(p));
    return {
      key: g.key,
      label: g.label,
      perms: g.perms.map((p) => ({ p, label: PERMISSIONS[p], sensitive: isSensitive(p), disabled: !!RESTRICTED[p] && !RESTRICTED[p]!.includes(role) })),
      turnOn: base.length ? base : g.on,
    };
  });
  const effOf = (r: Role) => effectivePermissions(r, overrides);
  return (
    <div className="space-y-4">
      <PageHeader title="Pengguna & hak akses" subtitle="RBAC sampai tingkat menu dan tindakan" actions={tab === "pengguna" && <Modal trigger="+ Pengguna" title="Pengguna baru">{form()}</Modal>} />
      <Tabs current={tab} tabs={[{ key: "pengguna", label: "Pengguna", href: "?tab=pengguna", count: users.length }, { key: "akses", label: "Hak akses", href: "?tab=akses" }]} />
      {tab === "pengguna" ? (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>Karyawan/Divisi</th><th>Login terakhir</th><th>Status</th><th /></tr></thead>
            <tbody>{users.map((u) => <tr key={u.id}><td className="font-mono text-xs">{u.username}</td><td>{u.name}{u.email && <div className="text-xs text-slate-500">{u.email}</div>}</td><td><Badge tone="blue">{ROLE_LABEL[u.role]}</Badge></td><td className="text-xs">{u.employee?.code}{u.division && ` · ${u.division.name}`}</td><td className="text-xs">{fmtDateTime(u.lastLoginAt)}</td><td>{u.active ? (u.lockedUntil && u.lockedUntil > new Date() ? <Badge tone="red">Terkunci</Badge> : <Badge tone="green">Aktif</Badge>) : <Badge>Nonaktif</Badge>}</td><td>{(u.role !== "OWNER" || me.role === "OWNER") && <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${u.username}`}>{form(u)}</Modal>}</td></tr>)}</tbody>
          </table></Paged>
        </div>
      ) : (
        <>
          <Tabs current={role} tabs={ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r], href: `?tab=akses&role=${r}` }))} />
          <Card title={`Hak akses ${ROLE_LABEL[role]}`}>
            {role === "OWNER" ? <p className="text-sm text-slate-500">Owner selalu memiliki semua hak akses, termasuk menu pengelolaan bot Telegram (khusus Owner).</p> : (
              // key={role}: form dibuat ulang tiap ganti role. Tanpa ini centangan role sebelumnya tertinggal di layar
              // dan ikut tersimpan ke role yang baru dibuka (penyebab Operator mendapat izin Finance, 13 Nov 2026).
              <ActionForm key={role} action={saveMatrix}>
                <input type="hidden" name="role" value={role} />
                <p className="mb-3 text-sm text-slate-500">
                  <b>Saklar besar</b> (kiri) = menu tampil atau tidak untuk role ini. Tekan <b>Rincian</b> untuk <b>saklar kecil</b>: tindakan apa saja yang boleh di dalam menu itu.
                  Label merah <span className="rounded bg-rose-100 px-1 text-[10px] font-semibold uppercase text-rose-700">sensitif</span> = data uang, gaji, atau pengaturan.
                  Menu yang dimatikan juga ditolak di server dan bot.
                </p>
                <RoleAccessEditor groups={accessGroups} initial={[...eff]} fieldRole={fieldRole} />
                <SensitiveGuard />
                <div className="mt-4"><Submit>Simpan hak akses {ROLE_LABEL[role]}</Submit></div>
              </ActionForm>
            )}
          </Card>
          <Card title="Ringkasan menu per role">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Menu</th>{ROLES.map((r) => <th key={r} className="text-center text-xs"><Link href={`?tab=akses&role=${r}`} className="link">{ROLE_LABEL[r]}</Link></th>)}</tr></thead>
                <tbody>
                  {MENU_GROUPS.map((g) => (
                    <tr key={g.key}>
                      <td className="font-medium">{g.label}</td>
                      {ROLES.map((r) => {
                        const e = effOf(r);
                        const shown = g.perms.some((p) => e.has(p));
                        const risky = FIELD_ROLES_SENSITIVE.includes(r) && g.perms.some((p) => e.has(p) && isSensitive(p));
                        return <td key={r} className={`text-center ${risky ? "font-bold text-rose-600" : shown ? "text-emerald-600" : "text-slate-300"}`} title={risky ? "Role lapangan punya izin sensitif di menu ini" : undefined}>{shown ? (risky ? "✓!" : "✓") : "–"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">✓! merah = role lapangan punya izin sensitif di menu itu; periksa bila tidak disengaja.</p>
          </Card>
        </>
      )}
    </div>
  );
}
