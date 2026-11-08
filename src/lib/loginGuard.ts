import bcrypt from "bcryptjs";
import type { User } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";

/**
 * Pengaman login (temuan audit S9).
 *
 * 1. Batas per IP: maks. IP_MAX_FAILS gagal dalam IP_WINDOW_MIN menit dari satu IP (semua username).
 * 2. Kunci bertahap per (username + IP): mulai PAIR_FREE_FAILS gagal, IP tersebut harus menunggu
 *    1, 2, 4, 8, lalu maks. 15 menit untuk username itu. Pemilik akun dari IP lain tidak ikut terkunci.
 * 3. Kunci akun bertahap (serangan dari banyak IP): setiap ACCOUNT_STEP gagal berturut-turut,
 *    akun dikunci sebentar 1, 2, 4, 8, lalu maks. 15 menit. Tidak pernah permanen.
 */
export const IP_WINDOW_MIN = 15;
export const IP_MAX_FAILS = 20;
export const PAIR_WINDOW_MIN = 60;
export const PAIR_FREE_FAILS = 5;
export const ACCOUNT_STEP = 20;
export const MAX_WAIT_MIN = 15;
const KEEP_DAYS = 2;
const DUMMY_HASH = "$2a$10$abcdefghijklmnopqrstuuJ0b1V7wq4w1mJ8q3h0Q3Z5c1rK6uE2";

const MIN = 60_000;

/** Lama tunggu (menit) per (username + IP) setelah `fails` gagal: 0 sebelum batas, lalu 1,2,4,8,15. */
export function pairWaitMinutes(fails: number) {
  if (fails < PAIR_FREE_FAILS) return 0;
  return Math.min(MAX_WAIT_MIN, 2 ** (fails - PAIR_FREE_FAILS));
}

/** Lama kunci akun (menit) setelah `failed` gagal berturut-turut: tiap kelipatan ACCOUNT_STEP → 1,2,4,8,15. */
export function accountLockMinutes(failed: number) {
  if (failed <= 0 || failed % ACCOUNT_STEP !== 0) return 0;
  return Math.min(MAX_WAIT_MIN, 2 ** (failed / ACCOUNT_STEP - 1));
}

function waitText(until: Date, now: Date) {
  const m = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / MIN));
  return `${m} menit`;
}

/**
 * Ambil IP asli pengunjung. Di belakang Cloudflare → Nginx:
 * - CF-Connecting-IP diisi Cloudflare (tidak bisa dipalsukan bila origin hanya menerima dari Cloudflare);
 * - X-Real-IP diisi Nginx ($remote_addr);
 * - X-Forwarded-For: ambil entri PALING KANAN (yang ditambahkan proxy kita), bukan paling kiri
 *   yang bisa diisi bebas oleh pengunjung.
 */
export function ipFromHeaders(h: { get(name: string): string | null }): string {
  const clean = (v: string | null | undefined) => (v ?? "").trim().slice(0, 64);
  const cf = clean(h.get("cf-connecting-ip"));
  if (cf) return cf;
  const real = clean(h.get("x-real-ip"));
  if (real) return real;
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return clean(xff[xff.length - 1]);
  return "unknown";
}

export type GuardResult = { ok: true; user: User } | { ok: false; error: string };

const GENERIC = "Username atau password salah";

/** Periksa username/password dengan semua batas di atas. Tidak menyentuh cookie. */
export async function checkLogin(usernameRaw: string, password: string, ip: string, now = new Date()): Promise<GuardResult> {
  const username = usernameRaw.trim().toLowerCase().slice(0, 64);
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_DAYS * 24 * 60 * MIN) } } });

  // 1. Batas per IP (semua username)
  const ipSince = new Date(now.getTime() - IP_WINDOW_MIN * MIN);
  const ipFails = await prisma.loginAttempt.findMany({
    where: { ip, success: false, createdAt: { gte: ipSince, lte: now } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (ipFails.length >= IP_MAX_FAILS) {
    const until = new Date(ipFails[ipFails.length - IP_MAX_FAILS].createdAt.getTime() + IP_WINDOW_MIN * MIN);
    return { ok: false, error: `Terlalu banyak percobaan login dari jaringan ini. Coba lagi ${waitText(until, now)} lagi.` };
  }

  // 2. Kunci bertahap per (username + IP): hitung gagal sejak login berhasil terakhir dari IP ini
  const pairSince = new Date(now.getTime() - PAIR_WINDOW_MIN * MIN);
  const lastOk = await prisma.loginAttempt.findFirst({
    where: { ip, username, success: true, createdAt: { gte: pairSince, lte: now } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const pairFails = await prisma.loginAttempt.findMany({
    where: { ip, username, success: false, createdAt: { gte: lastOk?.createdAt ?? pairSince, lte: now } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const wait = pairWaitMinutes(pairFails.length);
  if (wait > 0) {
    const until = new Date(pairFails[0].createdAt.getTime() + wait * MIN);
    if (until > now) return { ok: false, error: `Terlalu banyak percobaan untuk akun ini. Coba lagi ${waitText(until, now)} lagi.` };
  }

  const record = (success: boolean) => prisma.loginAttempt.create({ data: { ip, username, success, createdAt: now } });

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !user.active) {
    await bcrypt.compare(password, DUMMY_HASH); // samakan waktu respons
    await record(false);
    return { ok: false, error: GENERIC };
  }

  // 3. Kunci akun sementara (serangan dari banyak IP)
  if (user.lockedUntil && user.lockedUntil > now) {
    return { ok: false, error: `Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi ${waitText(user.lockedUntil, now)} lagi.` };
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    const lockMin = accountLockMinutes(failed);
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: failed, lockedUntil: lockMin ? new Date(now.getTime() + lockMin * MIN) : user.lockedUntil },
    });
    await record(false);
    await audit({ actorId: user.id, actorName: user.name }, "LOGIN_GAGAL", "User", user.id, { ip });
    return { ok: false, error: GENERIC };
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  await record(true);
  return { ok: true, user };
}

/** Data Prisma untuk mengganti password: buka kunci + cabut semua sesi lama (versi sesi naik). */
export function passwordChangeData(passwordHash: string) {
  return { passwordHash, failedLogins: 0, lockedUntil: null, sessionVersion: { increment: 1 } };
}

/** Hapus catatan gagal login untuk username (dipakai saat admin mereset password = "buka kunci"). */
export async function clearLoginBlocks(username: string) {
  await prisma.loginAttempt.deleteMany({ where: { username: username.trim().toLowerCase(), success: false } });
}
