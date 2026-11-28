import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
export const KIND_FINANCE_TX = "FINANCE_TX";

/** Pasangan urut (A < B) agar (X, Y) dan (Y, X) = baris yang sama */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Tandai dua transaksi keuangan "bukan dobel" (permanen). Tidak mengubah transaksi/jurnal apa pun; hanya audit-duplikat-keuangan
 * yang tidak lagi melaporkan pasangan ini. Idempoten.
 */
export async function tandaiBukanDobel(db: PrismaClient, numberA: string, numberB: string, reason: string | null, actor: string, apply: boolean) {
  const [a, b] = pairKey(numberA.trim(), numberB.trim());
  if (!a || !b || a === b) throw new Error("Dua nomor transaksi berbeda diperlukan");
  const found = await db.financeTransaction.findMany({ where: { number: { in: [a, b] } }, select: { number: true } });
  const missing = [a, b].filter((n) => !found.some((f) => f.number === n));
  if (missing.length) throw new Error(`Transaksi tidak ditemukan: ${missing.join(", ")}`);
  const exists = await db.duplicateDismissal.findUnique({ where: { kind_keyA_keyB: { kind: KIND_FINANCE_TX, keyA: a, keyB: b } } });
  if (apply && !exists) {
    await db.$transaction([
      db.duplicateDismissal.create({ data: { kind: KIND_FINANCE_TX, keyA: a, keyB: b, reason, createdBy: actor } }),
      db.auditLog.create({ data: { actorName: actor, action: "TANDAI_BUKAN_DOBEL", entity: "FinanceTransaction", entityId: `${a}|${b}`, data: { a, b, reason } } }),
    ]);
  }
  return { a, b, already: !!exists };
}

export type KandidatKembar = { kind: "TRANSFER_KEMBAR" | "DIBUKUKAN_DOBEL"; a: string; b: string; amount: number };

/** Kandidat transaksi keuangan dobel (sama dengan audit-duplikat-keuangan), TANPA pasangan yang sudah ditandai bukan dobel */
export async function kandidatTransaksiKembar(db: PrismaClient): Promise<KandidatKembar[]> {
  const tf = await db.$queryRaw<{ number: string; n2: string; amt: string }[]>`
    SELECT a.number, b.number n2, a.amount::text amt FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.direction=a.direction AND b."accountId"=a."accountId" AND b."toAccountId" IS NOT DISTINCT FROM a."toAccountId" AND b.amount=a.amount
      AND ABS(EXTRACT(EPOCH FROM (b.date-a.date)))<180
    WHERE a.direction='TRANSFER' AND a.status NOT IN ('DITOLAK','DIBATALKAN') AND b.status NOT IN ('DITOLAK','DIBATALKAN') AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "DuplicateDismissal" d WHERE d.kind='FINANCE_TX' AND d."keyA"=LEAST(a.number,b.number) AND d."keyB"=GREATEST(a.number,b.number)) LIMIT 500`;
  const dp = await db.$queryRaw<{ number: string; n2: string; amt: string }[]>`
    SELECT a.number, b.number n2, a.amount::text amt FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.fingerprint=a.fingerprint AND b.note IS NOT DISTINCT FROM a.note AND b."createdBy"=a."createdBy"
      AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<180
    WHERE a.direction<>'TRANSFER' AND a.status='DIBUKUKAN' AND b.status='DIBUKUKAN' AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "DuplicateDismissal" d WHERE d.kind='FINANCE_TX' AND d."keyA"=LEAST(a.number,b.number) AND d."keyB"=GREATEST(a.number,b.number)) LIMIT 500`;
  return [
    ...tf.map((r) => ({ kind: "TRANSFER_KEMBAR" as const, a: r.number, b: r.n2, amount: Number(r.amt) })),
    ...dp.map((r) => ({ kind: "DIBUKUKAN_DOBEL" as const, a: r.number, b: r.n2, amount: Number(r.amt) })),
  ];
}
