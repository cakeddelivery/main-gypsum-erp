import { SignJWT } from "jose";

/**
 * Sesi login panjang yang diperpanjang otomatis (rolling): token berlaku 90 hari dan diterbitkan ulang
 * saat sisa masa berlakunya < 30 hari dan user masih memakai ERP. Jadi user tidak keluar sendiri kecuali
 * menekan Keluar, ganti/reset password, akun dinonaktifkan, atau Owner "Keluarkan semua perangkat"
 * (semuanya dicek di server tiap permintaan lewat sessionVersion & status akun).
 * File ini aman untuk middleware (Edge): tanpa Prisma / server-only.
 */
export const SESSION_COOKIE = "mg_session";
export const SESSION_DAYS = 90;
export const RENEW_WHEN_LEFT_DAYS = 30;
const DAY = 86_400;

export function sessionSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET belum diatur (min. 32 karakter)");
  return new TextEncoder().encode(s);
}

export function signSession(userId: string, sessionVersion = 0) {
  return new SignJWT({ sub: userId, sv: sessionVersion }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(sessionSecret());
}

/** Perlu diperpanjang bila sisa masa berlaku token < 30 hari (exp dalam detik) */
export function needsRenewal(exp: number | undefined, nowSec = Math.floor(Date.now() / 1000)) {
  return typeof exp === "number" && exp - nowSec < RENEW_WHEN_LEFT_DAYS * DAY;
}

/** Cookie httpOnly, SameSite=Lax (tetap terkirim saat PWA/iPhone dibuka dari ikon), Secure di production */
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_DAYS * DAY };
}
