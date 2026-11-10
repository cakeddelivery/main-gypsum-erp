import { prisma } from "./db";
import type { Permission } from "./rbac";
import { esc, type InlineButton } from "./telegram";
import type { BotIdent } from "./botMenu";

/** Bagian bersama isian bertahap bot Telegram (dipakai botFlow & botFlow3) */
export const MENU_TEXT = "📋 Menu";
export const PAGE = 10;

export type Data = Record<string, string | number | null | undefined>;
export type Session = { chatId: string; userId: string; flow: string; step: string; data: Data };
export type Prompt = { text: string; buttons?: InlineButton[][]; replyKeyboard?: { text: string; request_location?: boolean }[][] };
export type Ctx = { i: BotIdent; chatId: string; messageId?: number };

/** Chat grup/supergroup Telegram punya id negatif; chat pribadi positif */
export const isGroupChat = (chatId: string | number) => String(chatId).startsWith("-");

/**
 * Kunci sesi isian (BotSession.chatId): chat pribadi = id chat; grup = id chat + pengguna ERP, sehingga dua orang
 * di grup yang sama mengisi sendiri-sendiri tanpa saling menimpa.
 */
export const sessionKey = (chatId: string, userId: string) => (isGroupChat(chatId) ? `${chatId}:${userId}` : chatId);
/** Id chat asli dari kunci sesi */
export const chatOfKey = (key: string) => key.split(":")[0];

export const can = (i: BotIdent, ...p: Permission[]) => p.some((x) => i.perms.has(x));
export const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, k) => arr.slice(k * n, k * n + n));
export const cancelRow: InlineButton[] = [{ text: "❌ Batal", callback_data: "f:x" }];

// ---------- Angka ----------
export function parseCount(s: string): number | null {
  const t = s.trim().replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ""));
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

export function parseQty(s: string): number | null {
  const t = s.trim().replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ""));
  if (!/^\d+([.,]\d+)?$/.test(t)) return null;
  return Number(t.replace(",", "."));
}

export const fmtQty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString("id-ID");

export async function userDivision(i: BotIdent): Promise<string | null> {
  if (i.user.divisionId) return i.user.divisionId;
  if (!i.user.employeeId) return null;
  return (await prisma.employee.findUnique({ where: { id: i.user.employeeId }, select: { divisionId: true } }))?.divisionId ?? null;
}

export function pager(page: number, more: boolean): InlineButton[][] {
  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: "◀ Sebelumnya", callback_data: "f:pg:" + (page - 1) });
  if (more) nav.push({ text: "Berikutnya ▶", callback_data: "f:pg:" + (page + 1) });
  return nav.length ? [nav] : [];
}

export async function searchItems(q: string) {
  const t = q.trim();
  if (t.length < 2) return [];
  return prisma.item.findMany({ where: { active: true, OR: [{ name: { contains: t, mode: "insensitive" } }, { sku: { contains: t, mode: "insensitive" } }] }, orderBy: { name: "asc" }, take: 10 });
}

export function itemPrompt(head: string): Prompt {
  return { text: `${head}\n\n✍️ Ketik nama atau kode bahan/barang (minimal 2 huruf), contoh: <code>gypsum</code>`, buttons: [cancelRow] };
}

export async function itemChoices(head: string, q: string): Promise<Prompt | string> {
  const items = await searchItems(q);
  if (!items.length) return `Tidak ada barang yang cocok dengan "${q.slice(0, 30)}". Ketik nama lain.`;
  return { text: `${head}\nHasil pencarian "${esc(q.slice(0, 30))}":`, buttons: [...items.map((x) => [{ text: `${x.name} (${x.unit})`.slice(0, 50), callback_data: `f:${x.id}` }]), [{ text: "🔎 Cari lagi", callback_data: "f:again" }], cancelRow] };
}
