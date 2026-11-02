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
export async function sendTelegram(chatId: string, text: string, opts: { buttons?: InlineButton[][]; keyboard?: string[][]; type?: string } = {}) {
  const r = await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    ...(opts.keyboard ? { reply_markup: { keyboard: opts.keyboard.map((row) => row.map((t) => ({ text: t }))), resize_keyboard: true, is_persistent: true } } : {}),
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

/** Status "sedang mengirim file…" di chat selama dokumen dibuat */
export async function chatAction(chatId: string, action: "typing" | "upload_document" = "typing") {
  return call("sendChatAction", { chat_id: chatId, action });
}

/** Kirim file (mis. JPG laporan) sebagai dokumen agar kualitasnya utuh, tidak dikompres seperti foto */
export async function sendTelegramDocument(chatId: string, file: Buffer, filename: string, caption: string, opts: { buttons?: InlineButton[][]; type?: string } = {}) {
  let r: { ok: boolean; error?: string };
  if (!token()) r = { ok: false, error: "TELEGRAM_BOT_TOKEN belum diatur" };
  else {
    try {
      const fd = new FormData();
      fd.set("chat_id", chatId);
      fd.set("caption", caption);
      fd.set("parse_mode", "HTML");
      if (opts.buttons) fd.set("reply_markup", JSON.stringify({ inline_keyboard: opts.buttons }));
      fd.set("document", new Blob([new Uint8Array(file)], { type: filename.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream" }), filename);
      const res = await fetch(`https://api.telegram.org/bot${token()}/sendDocument`, { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
      const json = (await res.json()) as { ok: boolean; description?: string };
      r = json.ok ? { ok: true } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
  }
  await prisma.notificationLog.create({
    data: { channel: "TELEGRAM", type: opts.type ?? "DOKUMEN", target: chatId, status: r.ok ? "TERKIRIM" : "GAGAL", payload: `${filename} · ${caption}`.slice(0, 2000), error: r.error ?? null },
  });
  return r;
}

/** Daftar perintah yang muncul di tombol "Menu" Telegram */
export async function setBotCommands() {
  return call("setMyCommands", {
    commands: [
      { command: "menu", description: "Menu utama ERP" },
      { command: "ringkasan", description: "Ringkasan hari ini" },
      { command: "laporan", description: "Unduh laporan JPG" },
      { command: "rekap", description: "Rekap harian keuangan & produksi" },
      { command: "id", description: "Lihat ID Telegram saya" },
      { command: "bantuan", description: "Cara mencatat transaksi" },
    ],
  });
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
