import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/public-url";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { ipFromHeaders } from "@/lib/loginGuard";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, exchangeCode, googleConfigured, googleLoginUser, readOAuthCookie, verifyIdToken, type GoogleError } from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

/** Balikan dari Google: cek state, tukar code (PKCE), verifikasi id_token + nonce, cocokkan email ke akun yang ada. */
export async function GET(req: NextRequest) {
  const fail = (e: GoogleError) => {
    const res = NextResponse.redirect(publicUrl(`/login?google=${e}`, req));
    res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  if (!googleConfigured()) return fail("tidak_aktif");
  const sp = req.nextUrl.searchParams;
  const st = await readOAuthCookie(req.cookies.get(OAUTH_COOKIE)?.value);
  const code = sp.get("code");
  if (!st || !code || sp.get("state") !== st.state) return fail("gagal");
  let claims;
  try {
    const idToken = await exchangeCode(code, st.verifier);
    claims = await verifyIdToken(idToken, st.nonce);
  } catch (e) {
    console.error("[google-login]", e instanceof Error ? e.message : e);
    return fail("gagal");
  }
  const r = await googleLoginUser(claims, ipFromHeaders(req.headers));
  if (!r.ok) return fail(r.error);
  const res = NextResponse.redirect(publicUrl(st.next, req));
  res.cookies.set(SESSION_COOKIE, await createSessionToken(r.user.id, r.user.sessionVersion), sessionCookieOptions());
  res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
  return res;
}
