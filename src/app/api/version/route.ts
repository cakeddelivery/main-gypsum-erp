import { NextResponse } from "next/server";
import { CURRENT_BUILD } from "@/lib/appVersion";

export const dynamic = "force-dynamic";

/** Versi build yang sedang berjalan di server; dicek aplikasi di HP untuk memuat ulang otomatis setelah deploy */
export function GET() {
  return NextResponse.json({ build: CURRENT_BUILD }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
