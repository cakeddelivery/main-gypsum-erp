import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cache } from "react";
import { prisma } from "./db";
import { effectivePermissions, type Permission } from "./rbac";
import { audit } from "./audit";
import { checkLogin, ipFromHeaders } from "./loginGuard";

import { SESSION_COOKIE, sessionCookieOptions, sessionSecret as secret, signSession } from "./session";

export { SESSION_COOKIE, sessionCookieOptions };

/** Token sesi 90 hari (diperpanjang otomatis di middleware selama user aktif) */
export async function createSessionToken(userId: string, sessionVersion = 0) {
  return signSession(userId, sessionVersion);
}

/** Isi token sesi: id user + versi sesi (token lama tanpa `sv` dianggap versi 0). */
export async function verifySessionToken(token: string): Promise<{ userId: string; sv: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.sub !== "string") return null;
    return { userId: payload.sub, sv: typeof payload.sv === "number" ? payload.sv : 0 };
  } catch {
    return null;
  }
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function setSessionCookie(userId: string, sessionVersion: number) {
  const token = await createSessionToken(userId, sessionVersion);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const r = await checkLogin(username, password, ipFromHeaders(await headers()));
  if (!r.ok) return r;
  await setSessionCookie(r.user.id, r.user.sessionVersion);
  await audit({ actorId: r.user.id, actorName: r.user.name }, "LOGIN", "User", r.user.id);
  return { ok: true };
}

/** Terbitkan ulang cookie sesi dengan versi terbaru (dipakai setelah ganti password sendiri). */
export async function refreshSession(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
  await setSessionCookie(userId, u.sessionVersion);
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
}

export type SessionUser = Awaited<ReturnType<typeof loadUser>>;

/** Muat user dari sesi; null bila nonaktif atau versi sesi sudah dicabut (password diganti). */
export async function loadUser(userId: string, sv = 0) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { employee: { include: { division: true } }, division: true },
  });
  if (!user || !user.active || user.sessionVersion !== sv) return null;
  const overrides = await prisma.rolePermission.findMany({ where: { role: user.role } });
  const perms = effectivePermissions(user.role, overrides);
  // Kapten Assembling ikut mengurus borongan (kirim bahan, setoran, terima hasil); anggota divisi (Kapten/Operator) yang
  // divisinya punya tugas borongan boleh mencatat setoran tugas itu. Tarif, pekerja & upah tetap pengelola (dicek di scope).
  const division = user.division ?? user.employee?.division ?? null;
  if ((user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR") && division) {
    const grant = (user.role === "KAPTEN_DIVISI" && division.reportTemplate === "ASSEMBLING") || (await prisma.pieceTask.count({ where: { divisionId: division.id, active: true } })) > 0;
    if (grant) for (const p of ["borongan.view", "borongan.point"] as const) perms.add(p);
  }
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
    employee: user.employee,
    divisionId: user.divisionId ?? user.employee?.divisionId ?? null,
    perms,
    can: (p: Permission) => perms.has(p),
  };
}

export const getUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await verifySessionToken(token);
  if (!s) return null;
  return loadUser(s.userId, s.sv);
});

export async function requireUser() {
  const u = await getUser();
  if (!u) redirect("/login");
  return u;
}

/** Wajibkan izin; dipakai di halaman (redirect) dan server action (throw). */
export async function requirePerm(...perms: Permission[]) {
  const u = await requireUser();
  if (!perms.some((p) => u.can(p))) redirect("/forbidden");
  return u;
}

export class ForbiddenError extends Error {
  constructor() {
    super("Anda tidak memiliki izin untuk tindakan ini");
  }
}

export async function assertPerm(...perms: Permission[]) {
  const u = await getUser();
  if (!u) throw new ForbiddenError();
  if (!perms.some((p) => u.can(p))) throw new ForbiddenError();
  return u;
}

export async function clientIp() {
  const h = await headers();
  return ipFromHeaders(h);
}

export async function hashPassword(pw: string) {
  if (pw.length < 8) throw new Error("Password minimal 8 karakter");
  return bcrypt.hash(pw, 10);
}

/**
 * Keluarkan akun dari semua perangkat (mis. HP hilang): versi sesi dinaikkan sehingga semua token lama ditolak.
 * Password tidak berubah; user cukup login ulang.
 */
export async function revokeAllSessions(userId: string, actor: { id: string; name: string }) {
  const u = await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  await audit(actor, "SESI_DICABUT_SEMUA", "User", userId, { username: u.username });
  return u;
}
