import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { prisma } from "@/lib/db";
import { checkLogin } from "@/lib/loginGuard";
import { createSessionToken, loadUser, verifySessionToken } from "@/lib/auth";
import type { MailMessage } from "@/lib/mail";
import { normEmail } from "@/lib/email";
import {
  RESET_INVALID,
  RESET_LIMIT_MESSAGE,
  RESET_NO_SMTP_MESSAGE,
  RESET_SENT_MESSAGE,
  RESET_ID_MAX,
  findValidResetToken,
  hashResetToken,
  requestPasswordReset,
  resetPasswordWithToken,
} from "@/lib/passwordReset";
import {
  exchangeCode,
  googleConfigured,
  googleLoginUser,
  googleRedirectUri,
  pkceChallenge,
  readOAuthCookie,
  safeNext,
  startGoogleLogin,
  verifyIdToken,
} from "@/lib/googleAuth";

const USER = "uji.reset";
const EMAIL = "uji.reset@gmail.com";
const PW = "password-lama-123";
const MIN = 60_000;
const T0 = new Date("2026-11-09T03:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * MIN);

let sent: MailMessage[] = [];
const send = async (m: MailMessage) => {
  sent.push(m);
};
const opts = (now = T0) => ({ now, send, configured: true, baseUrl: "https://tes.maingypsum.shop" });
const tokenFrom = (m: MailMessage) => decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m.text)![1]);

beforeEach(async () => {
  sent = [];
  await prisma.passwordResetRequest.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.upsert({
    where: { username: USER },
    create: { username: USER, name: "Uji Reset", role: "FINANCE", passwordHash, email: EMAIL },
    update: { passwordHash, email: EMAIL, failedLogins: 0, lockedUntil: null, active: true, sessionVersion: 0 },
  });
});

describe("Email akun", () => {
  it("dirapikan ke huruf kecil; kosong = null; format salah ditolak", () => {
    expect(normEmail("  Nama@Gmail.COM ")).toBe("nama@gmail.com");
    expect(normEmail("")).toBeNull();
    expect(() => normEmail("bukan-email")).toThrow("Format email");
  });
});

describe("Lupa password: token reset", () => {
  it("mengirim email berbahasa Indonesia berisi link; DB hanya menyimpan hash token", async () => {
    const r = await requestPasswordReset(USER, "1.1.1.1", opts());
    expect(r).toEqual({ ok: true, message: RESET_SENT_MESSAGE });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(EMAIL);
    expect(sent[0].subject).toContain("Reset password");
    expect(sent[0].html).toContain("Main Gypsum");
    expect(sent[0].html).toContain("https://tes.maingypsum.shop/brand/logo-main-gypsum.png");
    expect(sent[0].text).toContain("https://tes.maingypsum.shop/reset-password?token=");
    const token = tokenFrom(sent[0]);
    const rows = await prisma.passwordResetToken.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashResetToken(token));
    expect(rows[0].tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].expiresAt.getTime() - T0.getTime()).toBe(30 * MIN);
  });

  it("bisa diminta lewat email juga (huruf besar/kecil tidak masalah)", async () => {
    await requestPasswordReset("Uji.Reset@Gmail.com", "1.1.1.1", opts());
    expect(sent).toHaveLength(1);
  });

  it("pesan sama persis untuk akun yang tidak ada / tanpa email / nonaktif, dan tidak mengirim email", async () => {
    const ada = await requestPasswordReset(USER, "1.1.1.1", opts());
    const tidakAda = await requestPasswordReset("orang.lain", "1.1.1.2", opts());
    const emailAsing = await requestPasswordReset("asing@gmail.com", "1.1.1.3", opts());
    await prisma.user.update({ where: { username: USER }, data: { active: false } });
    const nonaktif = await requestPasswordReset(EMAIL, "1.1.1.4", opts());
    expect(tidakAda).toEqual(ada);
    expect(emailAsing).toEqual(ada);
    expect(nonaktif).toEqual(ada);
    expect(sent).toHaveLength(1);
    const logs = await prisma.auditLog.findMany({ where: { action: "RESET_PASSWORD_DIMINTA", at: { gte: new Date(Date.now() - 60_000) } } });
    expect(logs.length).toBeGreaterThanOrEqual(4);
  });

  it("dibatasi per akun dan per IP; pesan batas sama walau akun tidak ada", async () => {
    for (let i = 0; i < RESET_ID_MAX; i++) expect((await requestPasswordReset(USER, `2.2.2.${i}`, opts(at(i)))).ok).toBe(true);
    expect(await requestPasswordReset(USER, "2.2.2.9", opts(at(5)))).toEqual({ ok: false, error: RESET_LIMIT_MESSAGE });
    for (let i = 0; i < 10; i++) await requestPasswordReset(`tidak.ada${i}`, "3.3.3.3", opts(at(i)));
    expect(await requestPasswordReset("tidak.ada.lagi", "3.3.3.3", opts(at(11)))).toEqual({ ok: false, error: RESET_LIMIT_MESSAGE });
    // setelah 1 jam boleh lagi
    expect((await requestPasswordReset(USER, "2.2.2.9", opts(at(65)))).ok).toBe(true);
  });

  it("SMTP belum diatur → pesan Hubungi Owner, tanpa error dan tanpa email", async () => {
    const r = await requestPasswordReset(USER, "1.1.1.1", { ...opts(), configured: false });
    expect(r).toEqual({ ok: false, error: RESET_NO_SMTP_MESSAGE });
    expect(sent).toHaveLength(0);
  });

  it("sekali pakai: reset berhasil, sessionVersion naik, kunci dibuka, sesi lama keluar; token kedua kali ditolak", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    const oldToken = await createSessionToken(user.id, user.sessionVersion);
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 20, lockedUntil: at(60) } });
    await prisma.loginAttempt.create({ data: { ip: "6.6.6.6", username: USER, success: false } });
    await requestPasswordReset(USER, "1.1.1.1", opts());
    const token = tokenFrom(sent[0]);
    expect(await findValidResetToken(token, at(1))).not.toBeNull();

    const r = await resetPasswordWithToken(token, await bcrypt.hash("password-baru-456", 4), "1.1.1.1", at(1));
    expect(r.ok).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.sessionVersion).toBe(user.sessionVersion + 1);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(await prisma.loginAttempt.count({ where: { username: USER, success: false } })).toBe(0);
    const s = await verifySessionToken(oldToken);
    expect(await loadUser(s!.userId, s!.sv)).toBeNull(); // sesi lama dicabut
    expect((await checkLogin(USER, "password-baru-456", "1.1.1.1", at(2))).ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "RESET_PASSWORD_BERHASIL", entityId: user.id } })).toBeGreaterThan(0);

    // dipakai lagi → ditolak
    expect(await resetPasswordWithToken(token, await bcrypt.hash("password-ketiga-789", 4), "1.1.1.1", at(3))).toEqual({ ok: false, error: RESET_INVALID });
  });

  it("kedaluwarsa setelah 30 menit", async () => {
    await requestPasswordReset(USER, "1.1.1.1", opts());
    const token = tokenFrom(sent[0]);
    expect(await findValidResetToken(token, at(29))).not.toBeNull();
    expect(await findValidResetToken(token, at(30))).toBeNull();
    expect((await resetPasswordWithToken(token, "x", "1.1.1.1", at(31))).ok).toBe(false);
    const u = await prisma.user.findUniqueOrThrow({ where: { username: USER } });
    expect(await bcrypt.compare(PW, u.passwordHash)).toBe(true); // password tidak berubah
  });

  it("link baru membatalkan link lama; token palsu ditolak", async () => {
    await requestPasswordReset(USER, "1.1.1.1", opts());
    await requestPasswordReset(USER, "1.1.1.1", opts(at(1)));
    const [t1, t2] = sent.map(tokenFrom);
    expect(await findValidResetToken(t1, at(2))).toBeNull();
    expect(await findValidResetToken(t2, at(2))).not.toBeNull();
    expect(await findValidResetToken("token-palsu", at(2))).toBeNull();
  });
});

describe("Login dengan Google", () => {
  const CLIENT = "client-uji.apps.googleusercontent.com";

  async function setup() {
    process.env.GOOGLE_CLIENT_ID = CLIENT;
    process.env.GOOGLE_CLIENT_SECRET = "rahasia-uji";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, aud = CLIENT, iss = "https://accounts.google.com") =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return { keys, sign };
  }

  it("tombol hanya tampil bila env diatur; redirect URI per domain dari APP_URL", () => {
    expect(googleConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(googleConfigured({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(googleRedirectUri("https://erp.maingypsum.shop/")).toBe("https://erp.maingypsum.shop/api/auth/google/callback");
    expect(googleRedirectUri("https://tes.maingypsum.shop")).toBe("https://tes.maingypsum.shop/api/auth/google/callback");
  });

  it("URL login memakai state, nonce, dan PKCE S256; cookie state ditandatangani", async () => {
    await setup();
    const { url, cookie } = await startGoogleLogin("/finance", "https://tes.maingypsum.shop/api/auth/google/callback");
    const u = new URL(url);
    const st = await readOAuthCookie(cookie);
    expect(st).not.toBeNull();
    expect(u.searchParams.get("state")).toBe(st!.state);
    expect(u.searchParams.get("nonce")).toBe(st!.nonce);
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge(st!.verifier));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("client_id")).toBe(CLIENT);
    expect(st!.next).toBe("/finance");
    expect(await readOAuthCookie(cookie + "x")).toBeNull();
    expect(safeNext("//jahat.com")).toBe("/");
    expect(safeNext("https://jahat.com")).toBe("/");
  });

  it("menukar code dengan code_verifier (respons Google di-mock)", async () => {
    await setup();
    let body = "";
    const fake = async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ id_token: "abc" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect(await exchangeCode("kode", "verifier-xyz", "https://erp.maingypsum.shop/api/auth/google/callback", fake)).toBe("abc");
    const p = new URLSearchParams(body);
    expect(p.get("code_verifier")).toBe("verifier-xyz");
    expect(p.get("grant_type")).toBe("authorization_code");
    await expect(exchangeCode("kode", "v", "x", async () => new Response("{}", { status: 400 }))).rejects.toThrow();
  });

  it("verifikasi id_token: nonce, audience, issuer, tanda tangan", async () => {
    const { keys, sign } = await setup();
    const ok = await sign({ sub: "g1", email: "Uji.Reset@Gmail.com", email_verified: true, nonce: "n1" });
    expect(await verifyIdToken(ok, "n1", keys)).toEqual({ sub: "g1", email: EMAIL, emailVerified: true });
    await expect(verifyIdToken(ok, "n-lain", keys)).rejects.toThrow();
    await expect(verifyIdToken(await sign({ sub: "g1", email: EMAIL, nonce: "n1" }, "client-lain"), "n1", keys)).rejects.toThrow();
    await expect(verifyIdToken(await sign({ sub: "g1", email: EMAIL, nonce: "n1" }, CLIENT, "https://jahat.com"), "n1", keys)).rejects.toThrow();
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "g1", email: EMAIL, nonce: "n1" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience(CLIENT).setExpirationTime("5m").sign(other.privateKey);
    await expect(verifyIdToken(forged, "n1", keys)).rejects.toThrow();
  });

  it("menerima email terdaftar & terverifikasi; mencatat audit LOGIN_GOOGLE; sessionVersion dipakai", async () => {
    const before = await prisma.user.count();
    const r = await googleLoginUser({ sub: "g1", email: EMAIL, emailVerified: true }, "1.1.1.1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.username).toBe(USER);
    const tok = await createSessionToken(r.user.id, r.user.sessionVersion);
    const s = await verifySessionToken(tok);
    expect((await loadUser(s!.userId, s!.sv))?.role).toBe("FINANCE");
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_GOOGLE", entityId: r.user.id } })).toBeGreaterThan(0);
  });

  it("menolak email tak terdaftar (tidak membuat akun baru) dan email belum terverifikasi", async () => {
    const before = await prisma.user.count();
    expect(await googleLoginUser({ sub: "g2", email: "baru@gmail.com", emailVerified: true }, "1.1.1.1")).toEqual({ ok: false, error: "tidak_terdaftar" });
    expect(await googleLoginUser({ sub: "g1", email: EMAIL, emailVerified: false }, "1.1.1.1")).toEqual({ ok: false, error: "belum_terverifikasi" });
    expect(await prisma.user.count()).toBe(before);
  });

  it("menolak akun nonaktif dan akun terkunci", async () => {
    await prisma.user.update({ where: { username: USER }, data: { lockedUntil: new Date(Date.now() + 10 * MIN) } });
    expect(await googleLoginUser({ sub: "g1", email: EMAIL, emailVerified: true }, "1.1.1.1")).toEqual({ ok: false, error: "terkunci" });
    await prisma.user.update({ where: { username: USER }, data: { lockedUntil: null, active: false } });
    expect(await googleLoginUser({ sub: "g1", email: EMAIL, emailVerified: true }, "1.1.1.1")).toEqual({ ok: false, error: "nonaktif" });
  });
});
