import { prisma } from "./db";

export type InlineButton = { text: string; callback_data: string };

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

export function telegramConfigured() {
  return !!token();
}

async function call(method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!token()) return { ok: false, error: "TELEGRAM_BOT_TOKEN belum diatur" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    return json.ok ? { ok: true, result: json.result } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Kirim pesan + catat log pengiriman/kesalahan */
export async function sendTelegram(chatId: string, text: string, opts: { buttons?: InlineButton[][]; type?: string } = {}) {
  const r = await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
  });
  await prisma.notificationLog.create({
    data: { channel: "TELEGRAM", type: opts.type ?? "PESAN", target: chatId, status: r.ok ? "TERKIRIM" : "GAGAL", payload: text.slice(0, 2000), error: r.error ?? null },
  });
  return r;
}

export async function answerCallback(id: string, text: string) {
  return call("answerCallbackQuery", { callback_query_id: id, text });
}

export async function editTelegram(chatId: string, messageId: number, text: string, buttons?: InlineButton[][]) {
  return call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
}

/** Unduh file foto dari Telegram (bukti transaksi) */
export async function downloadTelegramFile(fileId: string): Promise<Buffer | null> {
  const r = await call("getFile", { file_id: fileId });
  if (!r.ok) return null;
  const path = (r.result as { file_path?: string }).file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
