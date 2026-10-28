import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/bot";
import { prisma } from "@/lib/db";

/**
 * Webhook Telegram Bot API. Diverifikasi dengan header X-Telegram-Bot-Api-Secret-Token.
 * Bila HERMES_WEBHOOK_URL diatur, pesan teks/foto diteruskan ke Hermes AI Agent
 * (Hermes lalu memanggil Finance API /api/v1). Tombol konfirmasi selalu ditangani di sini.
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const given = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const update = await req.json().catch(() => null);
  if (!update) return NextResponse.json({ ok: true });
  try {
    const hermes = process.env.HERMES_WEBHOOK_URL;
    const isCommand = typeof update.message?.text === "string" && update.message.text.startsWith("/");
    if (hermes && update.message && !isCommand) {
      const res = await fetch(hermes, { method: "POST", headers: { "content-type": "application/json", ...(process.env.HERMES_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.HERMES_WEBHOOK_TOKEN}` } : {}) }, body: JSON.stringify(update), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
    } else {
      await handleTelegramUpdate(update);
    }
  } catch (e) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "WEBHOOK", status: "GAGAL", error: (e as Error).message.slice(0, 500), payload: JSON.stringify(update).slice(0, 2000) } });
  }
  // Selalu 200 agar Telegram tidak mengulang update tanpa henti; kesalahan tercatat di log
  return NextResponse.json({ ok: true });
}
