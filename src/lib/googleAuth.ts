import { createHash, randomBytes } from "node:crypto";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { prisma } from "./db";
import { audit } from "./audit";
import { appUrl } from "./mail";

/**
 * Login dengan Google (OpenID Connect, authorization code + PKCE + state + nonce), tanpa library tambahan.
 * Hanya untuk akun yang SUDAH ada: email Google (terverifikasi) harus sama dengan email di User.
 * Tidak pernah membuat akun baru.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const OAUTH_COOKIE = "mg_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth/google";
export const OAUTH_TTL_SEC = 600;

export function googleConfigured(env: NodeJS.ProcessEnv = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Redirect URI per domain dari APP_URL (production & staging bisa memakai client yang sama). */
export function googleRedirectUri(base = appUrl()) {
  return `${base.replace(/\/+$/, "")}/api/auth/google/callback`;
}

const b64url = (b: Buffer) => b.toString("base64url");
export function pkceChallenge(verifier: string) {
  return b64url(createHash("sha256").update(verifier).digest());
}

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET belum diatur (min. 32 karakter)");
  return new TextEncoder().encode(s);
}

export type OAuthState = { state: string; nonce: string; verifier: string; next: string };

/** Buat URL login Google + isi cookie sementara (state/nonce/verifier ditandatangani AUTH_SECRET). */
export async function startGoogleLogin(next: string, redirectUri = googleRedirectUri()) {
  const st: OAuthState = {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(48)),
    next: safeNext(next),
  };
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state: st.state,
    nonce: st.nonce,
    code_challenge: pkceChallenge(st.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  const cookie = await new SignJWT({ ...st }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${OAUTH_TTL_SEC}s`).sign(secret());
  return { url: url.toString(), cookie };
}

export async function readOAuthCookie(value: string | undefined): Promise<OAuthState | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, secret());
    const { state, nonce, verifier, next } = payload as Record<string, unknown>;
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return null;
    return { state, nonce, verifier, next: safeNext(typeof next === "string" ? next : "/") };
  } catch {
    return null;
  }
}

export function safeNext(next: string) {
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next.slice(0, 300) : "/";
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Tukar authorization code menjadi id_token di endpoint token Google. */
export async function exchangeCode(code: string, verifier: string, redirectUri = googleRedirectUri(), fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google token HTTP ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Google tidak mengirim id_token");
  return json.id_token;
}

let jwks: JWTVerifyGetKey | null = null;
export type GoogleClaims = { sub: string; email: string; emailVerified: boolean };

/** Verifikasi tanda tangan, issuer, audience, kedaluwarsa, dan nonce id_token. */
export async function verifyIdToken(idToken: string, nonce: string, keys?: JWTVerifyGetKey): Promise<GoogleClaims> {
  keys ??= jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const { payload } = await jwtVerify(idToken, keys, { issuer: GOOGLE_ISSUERS, audience: process.env.GOOGLE_CLIENT_ID ?? "" });
  if (payload.nonce !== nonce) throw new Error("nonce tidak cocok");
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("id_token tanpa email");
  const ev = payload.email_verified;
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), emailVerified: ev === true || ev === "true" };
}

export const GOOGLE_ERRORS = {
  gagal: "Login dengan Google gagal. Coba lagi.",
  belum_terverifikasi: "Email Google Anda belum terverifikasi.",
  tidak_terdaftar: "Email Google ini belum terhubung ke akun ERP. Minta Owner/Admin mengisi email di akun Anda, atau masuk dengan username & password.",
  nonaktif: "Akun Anda nonaktif. Hubungi Owner.",
  terkunci: "Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi nanti.",
  tidak_aktif: "Login dengan Google belum diaktifkan.",
} as const;
export type GoogleError = keyof typeof GOOGLE_ERRORS;

/** Cocokkan klaim Google dengan akun yang SUDAH ada. Tidak pernah membuat akun baru. */
export async function googleLoginUser(c: GoogleClaims, ip: string, now = new Date()) {
  if (!c.emailVerified) {
    await audit(null, "LOGIN_GOOGLE_DITOLAK", "User", null, { ip, email: c.email, alasan: "belum_terverifikasi" });
    return { ok: false as const, error: "belum_terverifikasi" as GoogleError };
  }
  const user = await prisma.user.findUnique({ where: { email: c.email } });
  const reject = async (error: GoogleError) => {
    await audit(user ? { actorId: user.id, actorName: user.name } : null, "LOGIN_GOOGLE_DITOLAK", "User", user?.id ?? null, { ip, email: c.email, alasan: error });
    return { ok: false as const, error };
  };
  if (!user) return reject("tidak_terdaftar");
  if (!user.active) return reject("nonaktif");
  if (user.lockedUntil && user.lockedUntil > now) return reject("terkunci");
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  await audit({ actorId: user.id, actorName: user.name }, "LOGIN_GOOGLE", "User", user.id, { ip, email: c.email });
  return { ok: true as const, user };
}
