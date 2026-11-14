import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE, needsRenewal, sessionCookieOptions, signSession } from "@/lib/session";
import { publicUrl } from "@/lib/public-url";

const PUBLIC = ["/login", "/daftar", "/lupa-password", "/reset-password", "/api/auth/google", "/api/v1", "/api/telegram", "/api/cron", "/api/health", "/_next", "/favicon", "/icon", "/apple-icon", "/opengraph-image", "/twitter-image", "/brand/", "/ocr/", "/manifest.webmanifest", "/sw.js", "/offline", "/pwa/"];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let ok = false;
  let renewed: string | null = null;
  if (token && process.env.AUTH_SECRET) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.AUTH_SECRET));
      ok = true;
      // Sesi rolling: sisa < 30 hari → terbitkan token baru 90 hari (versi sesi sama; pencabutan tetap dicek di server)
      if (needsRenewal(payload.exp) && typeof payload.sub === "string") renewed = await signSession(payload.sub, typeof payload.sv === "number" ? payload.sv : 0);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    const url = publicUrl("/login", req);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  if (renewed) res.cookies.set(SESSION_COOKIE, renewed, sessionCookieOptions());
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
