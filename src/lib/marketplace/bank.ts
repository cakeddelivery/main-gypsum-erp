import { prisma } from "../db";
import { n } from "../money";

export const CH_WORDS: Record<string, RegExp> = { SHP: /shopee/i, TTS: /tiktok|tokopedia/i };
export const ref = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

export type Store = { id: string; name: string; code: string };

/** Rekening saldo marketplace per kanal; milik toko tertentu bila nama/alias memuat kode/nama toko */
export async function marketplaceBanks() {
  return prisma.bankAccount.findMany({ where: { marketplace: true, active: true }, select: { id: true, name: true, aliases: true } });
}
const mentionsStore = (b: { name: string; aliases: string }, x: Store) => new RegExp(`\\b${x.code}\\b|${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(`${b.name} ${b.aliases}`);
const channelBank = (b: { name: string; aliases: string }, ch: string) => CH_WORDS[ch].test(`${b.name} ${b.aliases}`);
/** Rekening milik toko ini: memuat kode/nama toko, atau satu-satunya toko */
const bankFor = (b: { name: string; aliases: string }, ch: string, s: Store, single: boolean) => channelBank(b, ch) && (mentionsStore(b, s) || single);
/** Rekening BERSAMA semua toko: memuat nama kanal tetapi tidak menyebut toko mana pun (mis. satu rekening "Saldo Penjual TikTok") */
const sharedBank = (b: { name: string; aliases: string }, ch: string, all: Store[]) => all.length > 1 && channelBank(b, ch) && !all.some((x) => mentionsStore(b, x));

export type Assign = { storeId: string | null; via: "TERSIMPAN" | "FILE_REF" | "FILE_NOMINAL" | "KEUANGAN" | "TIDAK_JELAS" };
type TxLite = { id: string; amount: number; date: Date; storeId: string | null; withdrawRef: string | null };
type FileLite = { id: string; storeId: string; refId: string; amount: number; date: Date | null };

/** Pasangkan satu-lawan-satu (nominal sama & tanggal berselisih ≤ tol hari), yang paling dekat dulu. Murni. */
export function greedyPair(txs: TxLite[], files: FileLite[], tolDays: number, allow: (t: TxLite, f: FileLite) => boolean = () => true): [TxLite, FileLite][] {
  const DAY = 86400000;
  const cand: { t: TxLite; f: FileLite; d: number }[] = [];
  for (const t of txs) for (const f of files) if (f.date && t.amount === f.amount && allow(t, f)) { const d = Math.abs(t.date.getTime() - f.date.getTime()); if (d <= tolDays * DAY) cand.push({ t, f, d }); }
  cand.sort((a, b) => a.d - b.d);
  const ut = new Set<string>(), uf = new Set<string>();
  const out: [TxLite, FileLite][] = [];
  for (const c of cand) if (!ut.has(c.t.id) && !uf.has(c.f.id)) { ut.add(c.t.id); uf.add(c.f.id); out.push([c.t, c.f]); }
  return out;
}

/**
 * Toko pemilik tiap withdraw di rekening BERSAMA. Urutan: tautan tersimpan → ID referensi (TikTok) → nominal & tanggal dengan file
 * toko yang tercatat di transaksi → nominal & tanggal dengan file SEMUA toko → toko di transaksi (tanpa padanan file) → tidak jelas.
 * Penetapan dari file disimpan di MarketplaceWithdrawLink (transaksi & jurnal tidak diubah).
 */
export async function sharedAssignments(ch: string, banks: Awaited<ReturnType<typeof marketplaceBanks>>, persist = true): Promise<Map<string, Assign>> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const ids = banks.filter((b) => sharedBank(b, ch, stores)).map((b) => b.id);
  const out = new Map<string, Assign>();
  if (!ids.length) return out;
  const [rows, links, fileRows] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { direction: "TRANSFER", accountId: { in: ids }, status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, deletedAt: null }, select: { id: true, amount: true, date: true, withdrawRef: true, storeId: true } }),
    prisma.marketplaceWithdrawLink.findMany({ where: { channel: ch } }),
    prisma.marketplaceWithdrawal.findMany({ where: { channel: ch, txType: { contains: "withdraw", mode: "insensitive" } }, select: { id: true, storeId: true, refId: true, amount: true, requestedAt: true } }),
  ]);
  const txs: TxLite[] = rows.map((r) => ({ id: r.id, amount: n(r.amount), date: r.date, storeId: r.storeId, withdrawRef: r.withdrawRef }));
  const files: FileLite[] = fileRows.map((f) => ({ id: f.id, storeId: f.storeId, refId: f.refId, amount: Math.abs(n(f.amount)), date: f.requestedAt }));
  const usedFile = new Set<string>();
  for (const l of links) { out.set(l.txId, { storeId: l.storeId, via: "TERSIMPAN" }); if (l.withdrawalId) usedFile.add(l.withdrawalId); }
  const tol = ch === "TTS" ? 4 : 2;
  const fresh: { txId: string; storeId: string; via: "FILE_REF" | "FILE_NOMINAL"; withdrawalId: string }[] = [];
  const take = (t: TxLite, f: FileLite, via: "FILE_REF" | "FILE_NOMINAL") => { out.set(t.id, { storeId: f.storeId, via }); usedFile.add(f.id); fresh.push({ txId: t.id, storeId: f.storeId, via, withdrawalId: f.id }); };
  let rest = txs.filter((t) => !out.has(t.id));
  // 1) ID referensi (TikTok)
  if (ch === "TTS") for (const t of rest) {
    const f = t.withdrawRef ? files.find((x) => !usedFile.has(x.id) && ref(x.refId) === ref(t.withdrawRef)) : undefined;
    if (f) take(t, f, "FILE_REF");
  }
  rest = rest.filter((t) => !out.has(t.id));
  // 2) toko yang tercatat di transaksi: file toko itu dulu
  for (const [t, f] of greedyPair(rest.filter((t) => t.storeId), files.filter((f) => !usedFile.has(f.id)), tol, (t, f) => f.storeId === t.storeId)) { out.set(t.id, { storeId: f.storeId, via: "KEUANGAN" }); usedFile.add(f.id); }
  rest = rest.filter((t) => !out.has(t.id));
  // 3) file semua toko (transaksi tanpa toko, atau tokonya tidak punya file yang cocok)
  for (const [t, f] of greedyPair(rest, files.filter((f) => !usedFile.has(f.id)), tol)) take(t, f, "FILE_NOMINAL");
  // 4) sisanya: toko di transaksi (tanpa padanan file) atau tidak jelas
  for (const t of txs) if (!out.has(t.id)) out.set(t.id, { storeId: t.storeId, via: t.storeId ? "KEUANGAN" : "TIDAK_JELAS" });
  if (persist && fresh.length) await prisma.marketplaceWithdrawLink.createMany({ data: fresh.map((f) => ({ ...f, channel: ch })), skipDuplicates: true }).catch(() => {});
  return out;
}

/** Withdraw yang sudah dicatat di Keuangan pada rentang waktu, per toko & kanal */
export async function recordedWithdraws(s: Store, ch: string, banks: Awaited<ReturnType<typeof marketplaceBanks>>, storeCount: number, from: Date, to: Date) {
  type Row = { id: string; amount: number; date: Date; withdrawRef: string | null; number?: string; status?: string; via?: Assign["via"] };
  const ownedIds = banks.filter((b) => bankFor(b, ch, s, storeCount === 1)).map((b) => b.id);
  const all = storeCount > 1 ? await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } }) : [];
  const sharedIds = banks.filter((b) => sharedBank(b, ch, all)).map((b) => b.id);
  if (!ownedIds.length && !sharedIds.length) return { rows: [] as Row[], noBank: true };
  const rows: Row[] = [];
  if (ownedIds.length) {
    const r = await prisma.financeTransaction.findMany({
      where: { direction: "TRANSFER", accountId: { in: ownedIds }, status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, deletedAt: null, date: { gte: from, lt: to }, OR: [{ storeId: s.id }, { storeId: null }] },
      select: { id: true, amount: true, date: true, withdrawRef: true, number: true, status: true },
    });
    rows.push(...r.map((x) => ({ id: x.id, amount: n(x.amount), date: x.date, withdrawRef: x.withdrawRef, number: x.number, status: x.status as string })));
  }
  if (sharedIds.length) {
    const assign = await sharedAssignments(ch, banks);
    const mine = [...assign.entries()].filter(([, a]) => a.storeId === s.id).map(([id]) => id);
    if (mine.length) {
      const r = await prisma.financeTransaction.findMany({ where: { id: { in: mine }, date: { gte: from, lt: to } }, select: { id: true, amount: true, date: true, withdrawRef: true, number: true, status: true } });
      rows.push(...r.filter((x) => !rows.some((y) => y.id === x.id)).map((x) => ({ id: x.id, amount: n(x.amount), date: x.date, withdrawRef: x.withdrawRef, number: x.number, status: x.status as string, via: assign.get(x.id)!.via })));
    }
  }
  return { rows, noBank: false };
}
