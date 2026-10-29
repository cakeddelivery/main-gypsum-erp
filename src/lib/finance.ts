import crypto from "node:crypto";
import { Prisma, type TxDirection, type TxSource, type TxStatus } from "@prisma/client";
import { prisma } from "./db";
import { nextNumber } from "./numbering";
import { postJournal, COA } from "./accounting";
import { audit } from "./audit";
import { addDays, dateStr, jakartaDateTime } from "./time";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string | null; name: string; telegramId?: string };

export const STATUS_LABEL: Record<TxStatus, string> = {
  DRAFT: "Draft",
  PERLU_DITINJAU: "Perlu Ditinjau",
  MENUNGGU_KONFIRMASI: "Menunggu Konfirmasi",
  DIBUKUKAN: "Dibukukan",
  DITOLAK: "Ditolak",
};

export class FinanceError extends Error {}

export type TxInput = {
  direction: TxDirection;
  amount: number;
  date: Date;
  accountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  suggestedCategoryId?: string | null;
  storeId?: string | null;
  counterparty?: string | null;
  note?: string | null;
  rawText?: string | null;
  proofPath?: string | null;
  proofMime?: string | null;
  aiExtraction?: Prisma.InputJsonValue | null;
  idempotencyKey?: string | null;
  telegramChatId?: string | null;
  telegramMessageId?: string | null;
};

export function fingerprint(direction: string, amount: number, date: Date, accountId?: string | null) {
  return crypto.createHash("sha256").update(`${direction}|${amount}|${dateStr(date)}|${accountId ?? "-"}`).digest("hex").slice(0, 32);
}

/** Cari transaksi lain (bukan ditolak) dengan nominal & rekening sama dalam ±1 hari */
export async function findDuplicate(tx: Tx | typeof prisma, input: { direction: TxDirection; amount: number; date: Date; accountId?: string | null }, excludeId?: string) {
  const from = new Date(input.date.getTime() - 86400000);
  const to = new Date(input.date.getTime() + 86400000);
  return tx.financeTransaction.findFirst({
    where: {
      id: excludeId ? { not: excludeId } : undefined,
      status: { not: "DITOLAK" },
      direction: input.direction,
      amount: BigInt(input.amount),
      accountId: input.accountId ?? undefined,
      date: { gte: from, lte: to },
    },
    orderBy: { createdAt: "asc" },
  });
}

export function missingFields(t: { direction: TxDirection; amount: number | bigint; accountId?: string | null; toAccountId?: string | null; categoryId?: string | null; storeId?: string | null }) {
  const m: string[] = [];
  if (!t.amount || Number(t.amount) <= 0) m.push("nominal");
  if (!t.accountId) m.push("rekening");
  if (!t.storeId) m.push("toko");
  if (t.direction === "TRANSFER") {
    if (!t.toAccountId) m.push("rekening tujuan");
    else if (t.toAccountId === t.accountId) m.push("rekening tujuan harus berbeda");
  } else if (!t.categoryId) m.push("kategori");
  return m;
}

function validateBasic(i: TxInput) {
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new FinanceError("Nominal harus bilangan bulat rupiah > 0 (IDR-only)");
  if (i.amount > 100_000_000_000) throw new FinanceError("Nominal melebihi batas wajar");
  if (isNaN(i.date.getTime())) throw new FinanceError("Tanggal tidak valid");
  if (i.direction === "TRANSFER" && i.categoryId) i.categoryId = null; // transfer internal tidak berkategori pendapatan/beban
}

/**
 * Buat transaksi di Finance Inbox. Tidak pernah membukukan jurnal.
 * - submit=false (manual) -> DRAFT
 * - submit=true / sumber AI & Telegram -> MENUNGGU_KONFIRMASI, atau PERLU_DITINJAU bila data kurang / terindikasi duplikat
 */
export async function createTransaction(input: TxInput, source: TxSource, actor: Actor, opts: { submit?: boolean } = {}) {
  validateBasic(input);
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.financeTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { transaction: existing, duplicate: null, replayed: true };
    }
    if (!input.storeId) {
      const def = await tx.setting.findUnique({ where: { key: "default_store_id" } });
      input.storeId = def?.value ?? null;
    }
    const dup = await findDuplicate(tx, input);
    const missing = missingFields(input);
    let status: TxStatus = "DRAFT";
    if (source !== "MANUAL" || opts.submit) status = dup || missing.length ? "PERLU_DITINJAU" : "MENUNGGU_KONFIRMASI";
    const number = await nextNumber(tx, "TRX", input.date);
    const t = await tx.financeTransaction.create({
      data: {
        number,
        source,
        direction: input.direction,
        amount: BigInt(input.amount),
        date: input.date,
        accountId: input.accountId ?? null,
        toAccountId: input.direction === "TRANSFER" ? input.toAccountId ?? null : null,
        categoryId: input.categoryId ?? null,
        suggestedCategoryId: input.suggestedCategoryId ?? null,
        storeId: input.storeId ?? null,
        counterparty: input.counterparty ?? null,
        note: input.note ?? null,
        rawText: input.rawText ?? null,
        proofPath: input.proofPath ?? null,
        proofMime: input.proofMime ?? null,
        aiExtraction: input.aiExtraction ?? undefined,
        status,
        fingerprint: fingerprint(input.direction, input.amount, input.date, input.accountId),
        duplicateOfId: dup?.id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: actor.name,
        telegramChatId: input.telegramChatId ?? null,
        telegramMessageId: input.telegramMessageId ?? null,
      },
    });
    await tx.approvalLog.create({
      data: { transactionId: t.id, action: "DIBUAT", toStatus: status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: dup ? `Indikasi duplikat dengan ${dup.number}` : missing.length ? `Data kurang: ${missing.join(", ")}` : null },
    });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIBUAT", "FinanceTransaction", t.id, { number, source, status, amount: input.amount }, tx);
    return { transaction: t, duplicate: dup, replayed: false };
  });
}

const EDITABLE: TxStatus[] = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"];

export async function updateTransaction(id: string, input: Partial<TxInput>, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (!EDITABLE.includes(cur.status)) throw new FinanceError("Transaksi yang sudah dibukukan/ditolak tidak dapat diubah");
    const merged = {
      direction: input.direction ?? cur.direction,
      amount: input.amount ?? Number(cur.amount),
      date: input.date ?? cur.date,
      accountId: input.accountId !== undefined ? input.accountId : cur.accountId,
      toAccountId: input.toAccountId !== undefined ? input.toAccountId : cur.toAccountId,
      categoryId: input.categoryId !== undefined ? input.categoryId : cur.categoryId,
      storeId: input.storeId !== undefined ? input.storeId : cur.storeId,
    };
    validateBasic({ ...merged, date: merged.date } as TxInput);
    if (merged.direction === "TRANSFER") merged.categoryId = null;
    const dup = await findDuplicate(tx, merged, id);
    // Perubahan data menurunkan status ke PERLU_DITINJAU agar dikonfirmasi ulang
    const status: TxStatus = cur.status === "DRAFT" ? "DRAFT" : "PERLU_DITINJAU";
    const t = await tx.financeTransaction.update({
      where: { id },
      data: {
        ...merged,
        amount: BigInt(merged.amount),
        toAccountId: merged.direction === "TRANSFER" ? merged.toAccountId : null,
        counterparty: input.counterparty !== undefined ? input.counterparty : undefined,
        note: input.note !== undefined ? input.note : undefined,
        proofPath: input.proofPath ?? undefined,
        proofMime: input.proofMime ?? undefined,
        fingerprint: fingerprint(merged.direction, merged.amount, merged.date, merged.accountId),
        duplicateOfId: dup?.id ?? null,
        status,
      },
    });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIUBAH", "FinanceTransaction", id, { before: { amount: cur.amount, accountId: cur.accountId, categoryId: cur.categoryId }, after: merged }, tx);
    return t;
  });
}

/** Ajukan / tinjau: DRAFT|PERLU_DITINJAU -> MENUNGGU_KONFIRMASI */
export async function submitForConfirmation(id: string, actor: Actor, note?: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status !== "DRAFT" && cur.status !== "PERLU_DITINJAU") throw new FinanceError("Status transaksi tidak dapat diajukan");
    const missing = missingFields({ ...cur });
    if (missing.length) throw new FinanceError(`Lengkapi data dahulu: ${missing.join(", ")}`);
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "MENUNGGU_KONFIRMASI" } });
    await tx.approvalLog.create({ data: { transactionId: id, action: cur.status === "DRAFT" ? "DIAJUKAN" : "DITINJAU", fromStatus: cur.status, toStatus: "MENUNGGU_KONFIRMASI", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: note ?? null } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIAJUKAN", "FinanceTransaction", id, null, tx);
    return t;
  });
}

export async function rejectTransaction(id: string, actor: Actor, reason: string) {
  if (!reason?.trim()) throw new FinanceError("Alasan penolakan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (!EDITABLE.includes(cur.status)) throw new FinanceError("Transaksi sudah final");
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DITOLAK" } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DITOLAK", fromStatus: cur.status, toStatus: "DITOLAK", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: reason } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DITOLAK", "FinanceTransaction", id, { reason }, tx);
    return t;
  });
}

/**
 * Setujui & bukukan. HANYA dipanggil setelah persetujuan manusia yang berwenang
 * (pengguna web dengan izin finance.approve, atau identitas Telegram terpetakan dengan canConfirm).
 * Atomik: status + jurnal + jejak persetujuan dalam satu transaksi database.
 */
export async function approveAndBook(id: string, actor: Actor & { id: string }, note?: string) {
  return prisma.$transaction(async (tx) => {
    // Kunci baris untuk mencegah pembukuan ganda saat konfirmasi bersamaan
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status === "DIBUKUKAN") throw new FinanceError("Transaksi sudah dibukukan");
    if (cur.status !== "MENUNGGU_KONFIRMASI") throw new FinanceError("Hanya transaksi berstatus Menunggu Konfirmasi yang dapat dibukukan");
    const missing = missingFields(cur);
    if (missing.length) throw new FinanceError(`Data belum lengkap: ${missing.join(", ")}`);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.accountId! } });
    const amount = Number(cur.amount);
    let lines;
    if (cur.direction === "TRANSFER") {
      const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.toAccountId! } });
      // Transfer internal: hanya memindahkan saldo antar rekening (bukan pendapatan/beban)
      lines = [
        { accountId: to.coaAccountId, debit: amount, memo: `Transfer dari ${bank.name}` },
        { accountId: bank.coaAccountId, credit: amount, memo: `Transfer ke ${to.name}` },
      ];
    } else {
      const cat = await tx.txCategory.findUniqueOrThrow({ where: { id: cur.categoryId! } });
      if (cat.direction !== cur.direction) throw new FinanceError("Kategori tidak sesuai jenis transaksi");
      lines =
        cur.direction === "MASUK"
          ? [
              { accountId: bank.coaAccountId, debit: amount, memo: cat.name },
              { accountId: cat.coaAccountId, credit: amount, memo: cur.note ?? undefined },
            ]
          : [
              { accountId: cat.coaAccountId, debit: amount, memo: cur.note ?? undefined },
              { accountId: bank.coaAccountId, credit: amount, memo: cat.name },
            ];
    }
    const journal = await postJournal(tx, {
      date: cur.date,
      storeId: cur.storeId!,
      description: `${cur.number} ${cur.note ?? ""}`.trim().slice(0, 200),
      source: "FINANCE",
      sourceId: cur.id,
      actor: { id: actor.id, name: actor.name },
      lines,
    });
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DIBUKUKAN", journalId: journal.id } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DISETUJUI_DIBUKUKAN", fromStatus: cur.status, toStatus: "DIBUKUKAN", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: note ?? `Jurnal ${journal.number}` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIBUKUKAN", "FinanceTransaction", id, { journal: journal.number, viaTelegram: actor.telegramId ?? null }, tx);
    return { transaction: t, journal };
  });
}

/** Saldo rekening = saldo akun COA terkait */
/** Saldo buku tiap rekening sampai akhir tanggal `upTo` (WIB) */
export async function bankBalancesAt(upTo: string) {
  const end = jakartaDateTime(addDays(upTo, 1), "00:00");
  const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: banks.map((b) => b.coaAccountId) }, journal: { date: { lt: end } } }, _sum: { debit: true, credit: true } });
  const m = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
  return banks.map((b) => ({ ...b, balance: m.get(b.coaAccountId) ?? 0 }));
}

/** Selisih saldo asli vs saldo buku per rekening → baris jurnal penyesuaian (lawan: Ekuitas Saldo Awal) */
export function balanceAdjustmentLines(rows: { coaAccountId: string; name: string; book: number; actual: number | null }[]) {
  const lines: { accountId?: string; accountCode?: string; debit?: number; credit?: number; memo?: string }[] = [];
  let net = 0;
  for (const r of rows) {
    if (r.actual === null) continue;
    const diff = r.actual - r.book;
    if (!diff) continue;
    lines.push({ accountId: r.coaAccountId, debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0, memo: `Saldo ${r.name}: buku ${r.book} → asli ${r.actual}` });
    net += diff;
  }
  if (net) lines.push({ accountCode: COA.EKUITAS_SALDO_AWAL, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, memo: "Penyeimbang saldo rekening" });
  return lines;
}

export async function bankBalances() {
  const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: banks.map((b) => b.coaAccountId) } }, _sum: { debit: true, credit: true } });
  const m = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
  return banks.map((b) => ({ ...b, balance: m.get(b.coaAccountId) ?? 0 }));
}
