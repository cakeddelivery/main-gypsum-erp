import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { runDueJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** Dipanggil cron eksternal tiap 5–15 menit: menjalankan rekap 07.00 WIB & tutup buku tgl 1 09.00 WIB bila jatuh tempo */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return new NextResponse("Forbidden", { status: 403 });
  return NextResponse.json({ ok: true, ran: await runDueJobs() });
}
export const GET = handle;
export const POST = handle;
