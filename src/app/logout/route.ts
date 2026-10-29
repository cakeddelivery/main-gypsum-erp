import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { publicUrl } from "@/lib/public-url";

export async function POST(req: Request) {
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.redirect(publicUrl("/login", req), 303);
}
