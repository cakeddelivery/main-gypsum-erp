import { prisma } from "../db";
import { n } from "../money";

export const CH_WORDS: Record<string, RegExp> = { SHP: /shopee/i, TTS: /tiktok|tokopedia/i };
export const ref = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

export type Store = { id: string; name: string; code: string };

/** Rekening saldo marketplace per kanal; milik toko tertentu bila nama/alias memuat kode/nama toko */
export async function marketplaceBanks() {
  return prisma.bankAccount.findMany({ where: { marketplace: true, active: true }, select: { id: true, name: true, aliases: true } });
}
const bankFor = (b: { name: string; aliases: string }, ch: string, s: Store, single: boolean) => {
  const text = `${b.name} ${b.aliases}`;
  if (!CH_WORDS[ch].test(text)) return false;
  const mentions = (x: Store) => new RegExp(`\\b${x.code}\\b|${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);
  return mentions(s) || single; // tanpa penanda toko di nama rekening: dipakai satu-satunya toko
};

/** Withdraw yang sudah dicatat di Keuangan pada rentang waktu, per toko & kanal */
export async function recordedWithdraws(s: Store, ch: string, banks: Awaited<ReturnType<typeof marketplaceBanks>>, storeCount: number, from: Date, to: Date) {
  const ids = banks.filter((b) => bankFor(b, ch, s, storeCount === 1)).map((b) => b.id);
  if (!ids.length) return { rows: [] as { id: string; amount: number; date: Date; withdrawRef: string | null; number?: string; status?: string }[], noBank: true };
  const rows = await prisma.financeTransaction.findMany({
    where: { direction: "TRANSFER", accountId: { in: ids }, status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, deletedAt: null, date: { gte: from, lt: to }, OR: [{ storeId: s.id }, { storeId: null }] },
    select: { id: true, amount: true, date: true, withdrawRef: true, number: true, status: true },
  });
  return { rows: rows.map((r) => ({ id: r.id, amount: n(r.amount), date: r.date, withdrawRef: r.withdrawRef, number: r.number, status: r.status as string })), noBank: false };
}

