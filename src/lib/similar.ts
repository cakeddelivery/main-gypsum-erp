import type { Prisma, TxDirection, TxStatus } from "@prisma/client";
import { prisma } from "./db";
import { addDays, dateOnly, dayRange, todayStr } from "./time";

/**
 * Cek transaksi mirip (satu sistem untuk web, API, dan semua alur bot).
 * Mirip = arah & nominal sama, di hari yang sama (WIB), rekening sama bila sama-sama diketahui. Hari sebelum/sesudahnya
 * ikut bila keterangan/pihaknya juga mirip, atau kategori & rekeningnya sama. Yang dicek: draft, menunggu, dibukukan, dan baris tertaut dari menu lain
 * (pembelian, gaji, kasbon, sisihan otomatis, ...). Sisihan otomatis tanpa bukti yang nanti dipakai oleh transfer
 * aslinya (lihat applyReserveLink) bukan duplikat dan tidak ikut.
 * Hasil disimpan sebagai duplicateOfId (status Perlu Ditinjau) atau ditanyakan bot sebelum menyimpan; transaksi yang
 * sudah dinyatakan "berbeda" disimpan di dupAckIds dan tidak ditanyakan lagi.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export type SimilarQuery = {
  direction: TxDirection;
  amount: number;
  date: Date;
  accountId?: string | null;
  toAccountId?: string | null;
  text?: string | null;
  categoryId?: string | null;
  /** Transaksi yang dikecualikan (mis. dirinya sendiri) dan yang sudah dinyatakan berbeda */
  excludeIds?: string[];
  /**
   * Transfer sisihan: dicocokkan per tanggal sisihannya. Transfer lain di hari yang sama yang menjadi bukti sisihan
   * TANGGAL LAIN (mis. OPS 8 Nov & OPS 9 Nov ditransfer bersamaan) bukan duplikat.
   */
  reserveParts?: { fundId: string; date: string }[];
  /** Withdraw TikTok: No. Referensi Seller Center. Sama = duplikat pasti (tanggal/nominal apa pun) */
  withdrawRef?: string | null;
};

export type SimilarHit = {
  id: string;
  number: string;
  date: Date;
  amount: number;
  direction: TxDirection;
  accountId: string | null;
  toAccountId: string | null;
  status: TxStatus;
  origin: string | null;
  note: string | null;
  counterparty: string | null;
  categoryId: string | null;
  score: number;
};

const STOP = new Set(["dari", "untuk", "yang", "dan", "ke", "via", "bayar", "beli", "transfer", "tf", "rp", "ribu", "juta", "rb", "jt", "hari", "ini", "kemarin", "seabank", "shopeepay", "dana", "bca", "bri", "bni", "mandiri", "tunai", "kas", "saldo", "pakai", "dengan", "lunas", "telegram"]);

export function tokens(s: string | null | undefined) {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)),
  );
}

export function overlap(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const w of a) if (b.has(w) || [...b].some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) n++;
  return n;
}

export async function findSimilar(db: Db, q: SimilarQuery, limit = 3): Promise<SimilarHit[]> {
  // No. Referensi withdraw sama = duplikat pasti
  const byRef = q.withdrawRef
    ? await db.financeTransaction.findMany({ where: { withdrawRef: q.withdrawRef, status: { notIn: ["DITOLAK", "DIBATALKAN"] }, deletedAt: null, id: q.excludeIds?.length ? { notIn: q.excludeIds } : undefined }, take: 3 })
    : [];
  if (byRef.length) return byRef.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: Number(r.amount), direction: r.direction, accountId: r.accountId, toAccountId: r.toAccountId, status: r.status, origin: r.origin, note: r.note, counterparty: r.counterparty, categoryId: r.categoryId, score: 100 })).slice(0, limit);
  if (!(q.amount > 0) || isNaN(q.date.getTime())) return [];
  const day = todayStr(q.date);
  const from = dayRange(addDays(day, -1)).start;
  const to = dayRange(addDays(day, 1)).end;
  const rows = await db.financeTransaction.findMany({
    where: {
      id: q.excludeIds?.length ? { notIn: q.excludeIds } : undefined,
      status: { notIn: ["DITOLAK", "DIBATALKAN"] },
      deletedAt: null,
      direction: q.direction,
      amount: BigInt(Math.round(q.amount)),
      date: { gte: from, lt: to },
    },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  if (!rows.length) return [];
  // Sisihan otomatis tanpa bukti & belum dipakai transfer: nanti diserap oleh transfer aslinya (tidak dobel)
  const sis = rows.filter((r) => r.origin === "SISIHAN" && r.journalId).map((r) => r.journalId!);
  const absorbable = new Set(
    sis.length ? (await db.reserveEntry.findMany({ where: { journalId: { in: sis }, type: "SISIH", transactionId: null, proofPath: null }, select: { journalId: true } })).map((e) => e.journalId!) : [],
  );
  const qt = tokens(q.text);
  const hits: SimilarHit[] = [];
  for (const r of rows) {
    if (r.journalId && absorbable.has(r.journalId)) continue;
    if (q.accountId && r.accountId && q.accountId !== r.accountId) continue;
    if (q.direction === "TRANSFER" && q.toAccountId && r.toAccountId && q.toAccountId !== r.toAccountId) continue;
    const sameDay = todayStr(r.date) === day;
    const words = overlap(qt, tokens([r.note, r.counterparty, r.rawText].filter(Boolean).join(" ")));
    // Hari sebelum/sesudahnya hanya bila keterangan mirip, atau kategori & rekening sama (bukan transfer harian)
    const sameCat = !!q.categoryId && r.categoryId === q.categoryId && !!q.accountId && r.accountId === q.accountId;
    if (!sameDay && words < 2 && !sameCat) continue;
    const score = (sameDay ? 3 : 0) + (q.accountId && r.accountId === q.accountId ? 2 : 0) + Math.min(words, 3) + (q.categoryId && r.categoryId === q.categoryId ? 1 : 0);
    hits.push({ id: r.id, number: r.number, date: r.date, amount: Number(r.amount), direction: r.direction, accountId: r.accountId, toAccountId: r.toAccountId, status: r.status, origin: r.origin, note: r.note, counterparty: r.counterparty, categoryId: r.categoryId, score });
  }
  if (q.reserveParts?.length && hits.length) {
    const entries = await db.reserveEntry.findMany({ where: { transactionId: { in: hits.map((h) => h.id) }, type: "SISIH" }, select: { transactionId: true, fundId: true, date: true } });
    const want = new Set(q.reserveParts.map((p) => `${p.fundId}|${p.date}`));
    const other = new Set(entries.filter((e) => !want.has(`${e.fundId}|${e.date.toISOString().slice(0, 10)}`)).map((e) => e.transactionId!));
    const same = new Set(entries.filter((e) => want.has(`${e.fundId}|${e.date.toISOString().slice(0, 10)}`)).map((e) => e.transactionId!));
    return hits.filter((h) => same.has(h.id) || !other.has(h.id)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Sisihan per tanggal sisihannya: tanggal yang sudah tercatat dengan bukti atau dari transfer lain = kemungkinan
 * transfer yang sama dicatat dua kali. Dikembalikan sebagai transaksi transfernya (bila ada).
 */
export async function similarReserveDates(db: Db, parts: { fundId: string; date: string }[]): Promise<SimilarHit[]> {
  if (!parts.length) return [];
  const entries = await db.reserveEntry.findMany({
    where: { type: "SISIH", OR: parts.map((p) => ({ fundId: p.fundId, date: dateOnly(p.date) })), NOT: { transactionId: null, proofPath: null } },
    include: { transaction: true },
  });
  const out: SimilarHit[] = [];
  for (const e of entries) {
    const t = e.transaction ?? (e.journalId ? await db.financeTransaction.findFirst({ where: { journalId: e.journalId } }) : null);
    if (!t || out.some((x) => x.id === t.id) || t.status === "DIBATALKAN" || t.status === "DITOLAK") continue;
    out.push({ id: t.id, number: t.number, date: t.date, amount: Number(t.amount), direction: t.direction, accountId: t.accountId, toAccountId: t.toAccountId, status: t.status, origin: t.origin, note: t.note, counterparty: t.counterparty, categoryId: t.categoryId, score: 5 });
  }
  return out;
}
