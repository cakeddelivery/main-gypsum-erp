import { prisma } from "./db";
import { audit } from "./audit";
import { hasExplicitAmount } from "./extract";

/**
 * Bot ERP di grup Telegram (Owner & Jojo mencatat di grup yang sama).
 * - Hanya grup yang didaftarkan Owner (/daftargrup di grup tsb) yang dilayani; grup lain didiamkan.
 * - Obrolan biasa diabaikan: diproses hanya perintah, foto/dokumen bukti, teks bernominal, balasan ke pesan bot,
 *   atau jawaban isian milik pengirim. Pengirim yang belum terdaftar didiamkan (kecuali /start, /id).
 * - Isian bertahap per orang (lihat sessionKey), kartu dibalas ke pesan pengirim, tombol kartu hanya untuk
 *   pembuatnya atau Owner/Finance.
 */
export const GROUP_SETTING = "telegram_grup_diizinkan";
export const GROUP_RECAP_SETTING = "telegram_grup_rekap";

export async function allowedGroups(): Promise<string[]> {
  const s = await prisma.setting.findUnique({ where: { key: GROUP_SETTING } });
  return (s?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

export async function isAllowedGroup(chatId: string) {
  return (await allowedGroups()).includes(chatId);
}

async function saveGroups(list: string[]) {
  const value = [...new Set(list)].join(",");
  await prisma.setting.upsert({ where: { key: GROUP_SETTING }, create: { key: GROUP_SETTING, value }, update: { value } });
}

export async function registerGroup(chatId: string, actor: { id: string; name: string }) {
  const list = await allowedGroups();
  if (list.includes(chatId)) return false;
  await saveGroups([...list, chatId]);
  await audit(actor, "TELEGRAM_GRUP_DIDAFTARKAN", "Setting", GROUP_SETTING, { chatId });
  return true;
}

export async function unregisterGroup(chatId: string, actor: { id: string; name: string }) {
  const list = await allowedGroups();
  if (!list.includes(chatId)) return false;
  await saveGroups(list.filter((x) => x !== chatId));
  await audit(actor, "TELEGRAM_GRUP_DIHAPUS", "Setting", GROUP_SETTING, { chatId });
  return true;
}

/** Rekap harian juga dikirim ke grup terdaftar (bawaan: mati) */
export async function groupRecapTargets(): Promise<string[]> {
  const s = await prisma.setting.findUnique({ where: { key: GROUP_RECAP_SETTING } });
  return s?.value === "1" ? allowedGroups() : [];
}

/** "/menu@MainGypsumErpBot" → "/menu" (perintah di grup menyertakan nama bot) */
export function normalizeCommand(text: string) {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, "$1");
}

/** Teks yang menyebut nominal: Rp/rb/jt, atau angka ≥ 4 digit / berpemisah ribuan */
export function mentionsAmount(text: string) {
  return hasExplicitAmount(text) || /\b\d{1,3}([.,]\d{3})+\b|\b\d{4,}\b/.test(text);
}

export type GroupMsg = { text: string; photo?: unknown[]; document?: unknown; location?: unknown; replyToBot: boolean; hasSession: boolean; menuText: string };

/** Pesan grup yang perlu diproses bot (selain itu obrolan biasa → diam) */
export function groupRelevant(m: GroupMsg) {
  return m.hasSession || m.text.startsWith("/") || m.text === m.menuText || !!m.photo?.length || !!m.document || m.replyToBot || mentionsAmount(m.text) || (!!m.location && m.hasSession);
}

/** Owner: nyalakan/matikan rekap harian ke grup. Mengembalikan status baru */
export async function toggleGroupRecap() {
  const cur = await prisma.setting.findUnique({ where: { key: GROUP_RECAP_SETTING } });
  const value = cur?.value === "1" ? "0" : "1";
  await prisma.setting.upsert({ where: { key: GROUP_RECAP_SETTING }, create: { key: GROUP_RECAP_SETTING, value }, update: { value } });
  return value === "1";
}

/** Grup terdaftar yang pengingatnya dimatikan Owner (/pengingatgrup); bawaan semua grup terdaftar NYALA */
export const GROUP_REMINDER_OFF = "telegram_grup_pengingat_mati";

async function remindersOff(): Promise<string[]> {
  const s = await prisma.setting.findUnique({ where: { key: GROUP_REMINDER_OFF } });
  return (s?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** Grup tujuan pengingat (cek saldo pagi & 12.00, withdraw TikTok dalam proses): terdaftar dan tidak dimatikan */
export async function reminderGroups(): Promise<string[]> {
  const off = new Set(await remindersOff());
  return (await allowedGroups()).filter((g) => !off.has(g));
}

/** Owner: nyalakan/matikan pengingat di grup ini. Mengembalikan true bila sekarang NYALA */
export async function toggleGroupReminders(chatId: string) {
  const off = await remindersOff();
  const next = off.includes(chatId) ? off.filter((x) => x !== chatId) : [...off, chatId];
  const value = next.join(",");
  await prisma.setting.upsert({ where: { key: GROUP_REMINDER_OFF }, create: { key: GROUP_REMINDER_OFF, value }, update: { value } });
  return !next.includes(chatId);
}
