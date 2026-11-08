import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import {
  ACCOUNT_STEP,
  IP_MAX_FAILS,
  accountLockMinutes,
  checkLogin,
  clearLoginBlocks,
  ipFromHeaders,
  pairWaitMinutes,
  passwordChangeData,
} from "@/lib/loginGuard";
import { createSessionToken, loadUser, verifySessionToken } from "@/lib/auth";

const USER = "uji.login";
const PW = "rahasia-benar-123";
const MIN = 60_000;
const T0 = new Date("2026-11-08T03:00:00Z");
const at = (menit: number) => new Date(T0.getTime() + menit * MIN);
const hdr = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

beforeEach(async () => {
  await prisma.loginAttempt.deleteMany({});
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.upsert({
    where: { username: USER },
    create: { username: USER, name: "Uji Login", role: "OPERATOR", passwordHash },
    update: { passwordHash, failedLogins: 0, lockedUntil: null, active: true, sessionVersion: 0 },
  });
});

describe("IP pengunjung", () => {
  it("memakai CF-Connecting-IP lebih dulu", () => {
    expect(ipFromHeaders(hdr({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9, 3.3.3.3" }))).toBe("1.1.1.1");
  });
  it("X-Forwarded-For diambil yang paling kanan (yang paling kiri bisa dipalsukan)", () => {
    expect(ipFromHeaders(hdr({ "x-forwarded-for": "6.6.6.6, 3.3.3.3" }))).toBe("3.3.3.3");
    expect(ipFromHeaders(hdr({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "6.6.6.6" }))).toBe("2.2.2.2");
    expect(ipFromHeaders(hdr({}))).toBe("unknown");
  });
});

describe("Aturan tunggu bertahap", () => {
  it("per username+IP: bebas 4 kali, lalu 1, 2, 4, 8, maks. 15 menit", () => {
    expect([4, 5, 6, 7, 8, 9, 20].map(pairWaitMinutes)).toEqual([0, 1, 2, 4, 8, 15, 15]);
  });
  it("kunci akun hanya di kelipatan 20 gagal, sebentar dan bertahap, tidak permanen", () => {
    expect(accountLockMinutes(19)).toBe(0);
    expect(accountLockMinutes(ACCOUNT_STEP)).toBe(1);
    expect(accountLockMinutes(ACCOUNT_STEP * 2)).toBe(2);
    expect(accountLockMinutes(ACCOUNT_STEP * 10)).toBe(15);
  });
});

describe("Login dengan batas percobaan", () => {
  it("5x salah dari IP penyerang tidak mengunci pemilik akun di IP lain", async () => {
    for (let i = 0; i < 5; i++) expect((await checkLogin(USER, "salah", "6.6.6.6", at(0))).ok).toBe(false);
    // penyerang harus menunggu, walau password benar
    const blocked = await checkLogin(USER, PW, "6.6.6.6", at(0.5));
    expect(blocked).toMatchObject({ ok: false, error: expect.stringMatching(/Coba lagi 1 menit/) });
    // pemilik dari IP lain tetap bisa masuk
    expect((await checkLogin(USER, PW, "1.2.3.4", at(0.5))).ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    expect(u.lockedUntil).toBeNull();
  });

  it("tunggu bertambah bertahap lalu bisa login lagi", async () => {
    for (let i = 0; i < 5; i++) await checkLogin(USER, "salah", "6.6.6.6", at(0));
    expect((await checkLogin(USER, "salah", "6.6.6.6", at(1.1))).ok).toBe(false); // gagal ke-6 → tunggu 2 menit
    expect(await checkLogin(USER, PW, "6.6.6.6", at(2))).toMatchObject({ ok: false, error: expect.stringMatching(/Coba lagi 2 menit/) });
    expect((await checkLogin(USER, PW, "6.6.6.6", at(3.2))).ok).toBe(true);
    // setelah berhasil, hitungan IP+username mulai dari nol lagi
    expect((await checkLogin(USER, "salah", "6.6.6.6", at(3.3))).ok).toBe(false);
    expect((await checkLogin(USER, PW, "6.6.6.6", at(3.4))).ok).toBe(true);
  });

  it(`batas per IP: ${IP_MAX_FAILS} gagal dalam 15 menit dari satu IP (username apa saja) diblokir`, async () => {
    for (let i = 0; i < IP_MAX_FAILS; i++) await checkLogin(`tebak${i}`, "salah", "7.7.7.7", at(i * 0.1));
    expect(await checkLogin(USER, PW, "7.7.7.7", at(3))).toMatchObject({ ok: false, error: expect.stringMatching(/dari jaringan ini/) });
    expect((await checkLogin(USER, PW, "8.8.8.8", at(3))).ok).toBe(true);
    expect((await checkLogin(USER, PW, "7.7.7.7", at(16))).ok).toBe(true);
  });

  it("serangan dari banyak IP mengunci akun sebentar (1 menit), bukan permanen", async () => {
    for (let i = 0; i < ACCOUNT_STEP; i++) await checkLogin(USER, "salah", `10.0.0.${i}`, at(0));
    const lock = await checkLogin(USER, PW, "1.2.3.4", at(0.5));
    expect(lock).toMatchObject({ ok: false, error: expect.stringMatching(/Akun dikunci sementara/) });
    expect((await checkLogin(USER, PW, "1.2.3.4", at(1.1))).ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    expect(u.failedLogins).toBe(0);
  });

  it("reset password oleh admin membuka blokir", async () => {
    for (let i = 0; i < 5; i++) await checkLogin(USER, "salah", "6.6.6.6", at(0));
    await clearLoginBlocks(USER);
    expect((await checkLogin(USER, PW, "6.6.6.6", at(0.2))).ok).toBe(true);
  });
});

describe("Cabut sesi lama saat password diganti", () => {
  it("JWT versi lama ditolak setelah password diganti, JWT baru diterima", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    const old = await verifySessionToken(await createSessionToken(u.id, u.sessionVersion));
    expect(old).toEqual({ userId: u.id, sv: 0 });
    expect(await loadUser(old!.userId, old!.sv)).not.toBeNull();

    const after = await prisma.user.update({ where: { id: u.id }, data: passwordChangeData(await bcrypt.hash("password-baru-123", 4)) });
    expect(after.sessionVersion).toBe(1);
    expect(await loadUser(old!.userId, old!.sv)).toBeNull();

    const fresh = await verifySessionToken(await createSessionToken(u.id, after.sessionVersion));
    expect((await loadUser(fresh!.userId, fresh!.sv))?.username).toBe(USER);
  });

  it("token lama tanpa versi (sebelum fitur ini) dianggap versi 0", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ sub: u.id }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.AUTH_SECRET));
    expect(await verifySessionToken(legacy)).toEqual({ userId: u.id, sv: 0 });
  });
});
