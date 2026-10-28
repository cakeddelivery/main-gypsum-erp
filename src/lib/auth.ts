import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cache } from "react";
import { prisma } from "./db";
import { effectivePermissions, type Permission } from "./rbac";
import { audit } from "./audit";

export const SESSION_COOKIE = "mg_session";
const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET belum diatur (min. 32 karakter)");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  const generic = { ok: false as const, error: "Username atau password salah" };
  if (!user || !user.active) {
    await bcrypt.compare(password, "$2a$10$abcdefghijklmnopqrstuuJ0b1V7wq4w1mJ8q3h0Q3Z5c1rK6uE2"); // samakan waktu respons
    return generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, error: "Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi nanti." };
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null },
    });
    await audit({ actorId: user.id, actorName: user.name }, "LOGIN_GAGAL", "User", user.id);
    return generic;
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const token = await createSessionToken(user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  await audit({ actorId: user.id, actorName: user.name }, "LOGIN", "User", user.id);
  return { ok: true };
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
}

export type SessionUser = Awaited<ReturnType<typeof loadUser>>;

async function loadUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { employee: { include: { division: true } }, division: true },
  });
  if (!user || !user.active) return null;
  const overrides = await prisma.rolePermission.findMany({ where: { role: user.role } });
  const perms = effectivePermissions(user.role, overrides);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
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
  const id = await verifySessionToken(token);
  if (!id) return null;
  return loadUser(id);
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
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export async function hashPassword(pw: string) {
  if (pw.length < 8) throw new Error("Password minimal 8 karakter");
  return bcrypt.hash(pw, 10);
}
