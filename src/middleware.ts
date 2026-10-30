import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { publicUrl } from "@/lib/public-url";

const PUBLIC = ["/login", "/api/v1", "/api/telegram", "/api/cron", "/api/health", "/_next", "/favicon", "/icon", "/apple-icon", "/opengraph-image", "/twitter-image", "/brand/", "/ocr/"];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const token = req.cookies.get("mg_session")?.value;
  let ok = false;
  if (token && process.env.AUTH_SECRET) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.AUTH_SECRET));
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    const url = publicUrl("/login", req);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
