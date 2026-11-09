import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/public-url";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_TTL_SEC, googleConfigured, startGoogleLogin } from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

/** Mulai login dengan Google: simpan state/nonce/PKCE di cookie sementara, lalu arahkan ke Google. */
export async function GET(req: NextRequest) {
  if (!googleConfigured()) return NextResponse.redirect(publicUrl("/login?google=tidak_aktif", req));
  const { url, cookie } = await startGoogleLogin(req.nextUrl.searchParams.get("next") ?? "/");
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_TTL_SEC,
  });
  return res;
}
