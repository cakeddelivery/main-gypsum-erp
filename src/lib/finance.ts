import crypto from "node:crypto";
import { Prisma, type TxDirection, type TxSource, type TxStatus } from "@prisma/client";
import { prisma } from "./db";
import { nextNumber } from "./numbering";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
import { locationSettings, recordMovement } from "./stock";
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
  DIBATALKAN: "Dibatalkan",
};

export class FinanceError extends Error {}

/** Pemasukan penjualan dari withdraw saldo penjual marketplace */
export function withdrawIncomeLines(sellerCoaId: string, sellerName: string, amount: number): LineInput[] {
  return [
    { accountId: sellerCoaId, debit: amount, memo: `Penjualan ${sellerName} (withdraw)` },
    { accountCode: COA.PENJUALAN, credit: amount, memo: `Penjualan ${sellerName} (withdraw)` },
  ];
}
export const WITHDRAW_INCOME_SOURCE = "WITHDRAW_PENJUALAN";

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
  /** Rincian (opsional): satu transfer untuk beberapa keperluan; jumlahnya harus = nominal */
  splits?: SplitInput[] | null;
  /** true = toko tidak diisi otomatis dengan toko default (withdraw yang tokonya belum jelas: ditanyakan) */
  askStore?: boolean;
};

export type SplitInput = { categoryId?: string | null; amount: number; note?: string | null; itemId?: string | null; qty?: number | null };

/** Masalah pada rincian: total tidak sama dengan nominal, atau baris tanpa kategori/bahan baku */
export function splitIssues(amount: number | bigint, direction: TxDirection, splits: { amount: number | bigint; categoryId?: string | null; itemId?: string | null; qty?: unknown }[]): string[] {
  if (!splits.length) return [];
  const out: string[] = [];
  if (direction === "TRANSFER") out.push("transfer internal tidak boleh punya rincian");
  const sum = splits.reduce((t, x) => t + Number(x.amount), 0);
  if (sum !== Number(amount)) out.push(`total rincian ${sum.toLocaleString("id-ID")} ≠ nominal ${Number(amount).toLocaleString("id-ID")}`);
  if (splits.some((x) => !(Number(x.amount) > 0))) out.push("nominal rincian harus > 0");
  if (splits.some((x) => !x.categoryId && !x.itemId)) out.push("kategori rincian");
  if (splits.some((x) => x.itemId && !(Number(x.qty) > 0))) out.push("jumlah barang rincian");
  if (direction === "MASUK" && splits.some((x) => x.itemId)) out.push("pemasukan tidak boleh berisi bahan baku");
  return out;
}

const splitRows = (splits: SplitInput[]) =>
  splits.map((x, i) => ({ categoryId: x.categoryId ?? null, amount: BigInt(Math.round(x.amount)), note: x.note?.slice(0, 200) ?? null, itemId: x.itemId ?? null, qty: x.itemId && x.qty ? new Prisma.Decimal(x.qty) : null, sortOrder: i }));

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
      status: { notIn: ["DITOLAK", "DIBATALKAN"] },
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
 * Buat transaksi di menu Transaksi. Tidak pernah membukukan jurnal.
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
    if (!input.storeId && !input.askStore) {
      const def = await tx.setting.findUnique({ where: { key: "default_store_id" } });
      input.storeId = def?.value ?? null;
    }
    const splits = input.direction === "TRANSFER" ? [] : (input.splits ?? []).filter((x) => x.amount > 0);
    // Kategori utama = kategori rincian terbesar (untuk daftar & laporan ringkas)
    if (splits.length && !input.categoryId) input.categoryId = [...splits].filter((x) => x.categoryId).sort((a, b) => b.amount - a.amount)[0]?.categoryId ?? null;
    const dup = await findDuplicate(tx, input);
    const missing = [...missingFields(input), ...splitIssues(input.amount, input.direction, splits)];
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
        splits: splits.length ? { create: splitRows(splits) } : undefined,
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
    if (input.splits !== undefined) {
      const splits = merged.direction === "TRANSFER" ? [] : (input.splits ?? []).filter((x) => x.amount > 0);
      await tx.financeTxSplit.deleteMany({ where: { transactionId: id } });
      if (splits.length) {
        await tx.financeTxSplit.createMany({ data: splitRows(splits).map((r) => ({ ...r, transactionId: id })) });
        if (input.categoryId === undefined || !merged.categoryId) merged.categoryId = [...splits].filter((x) => x.categoryId).sort((a, b) => b.amount - a.amount)[0]?.categoryId ?? merged.categoryId;
      }
    } else if (merged.direction === "TRANSFER") await tx.financeTxSplit.deleteMany({ where: { transactionId: id } });
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
    const missing = [...missingFields({ ...cur }), ...splitIssues(cur.amount, cur.direction, await tx.financeTxSplit.findMany({ where: { transactionId: id } }))];
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
    const splits = await tx.financeTxSplit.findMany({ where: { transactionId: id }, orderBy: { sortOrder: "asc" } });
    const missing = [...missingFields(cur), ...splitIssues(cur.amount, cur.direction, splits)];
    if (missing.length) throw new FinanceError(`Data belum lengkap: ${missing.join(", ")}`);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.accountId! } });
    const amount = Number(cur.amount);
    let lines: LineInput[];
    if (cur.direction === "TRANSFER") {
      const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.toAccountId! } });
      // Transfer internal: hanya memindahkan saldo antar rekening (bukan pendapatan/beban)
      lines = [
        { accountId: to.coaAccountId, debit: amount, memo: `Transfer dari ${bank.name}` },
        { accountId: bank.coaAccountId, credit: amount, memo: `Transfer ke ${to.name}` },
      ];
      // Withdraw saldo penjual marketplace = hasil penjualan di Shopee/TikTok: sekaligus dicatat sebagai pemasukan
      // (Dr Saldo Penjual / Cr Penjualan), sehingga saldo penjual tidak minus dan omzet toko tercatat
      if (bank.marketplace) lines.unshift(...withdrawIncomeLines(bank.coaAccountId, bank.name, amount));
    } else if (splits.length) {
      // Rincian: satu sisi rekening sebesar nominal, sisi lain dipecah per kategori / persediaan bahan baku
      const cats = await tx.txCategory.findMany({ where: { id: { in: splits.map((x) => x.categoryId).filter((x): x is string => !!x) } } });
      const items = await tx.item.findMany({ where: { id: { in: splits.map((x) => x.itemId).filter((x): x is string => !!x) } } });
      const parts: LineInput[] = splits.map((x) => {
        const it = items.find((i) => i.id === x.itemId);
        const cat = cats.find((c) => c.id === x.categoryId);
        if (!it && cat && cat.direction !== cur.direction) throw new FinanceError(`Kategori ${cat.name} tidak sesuai jenis transaksi`);
        const memo = (x.note ?? it?.name ?? cat?.name ?? "").slice(0, 120) || undefined;
        const acc = it ? { accountCode: COA.PERSEDIAAN_BAHAN } : { accountId: cat!.coaAccountId };
        return cur.direction === "MASUK" ? { ...acc, credit: Number(x.amount), memo } : { ...acc, debit: Number(x.amount), memo };
      });
      const label = cur.note?.slice(0, 120) ?? "Rincian";
      lines = cur.direction === "MASUK" ? [{ accountId: bank.coaAccountId, debit: amount, memo: label }, ...parts] : [...parts, { accountId: bank.coaAccountId, credit: amount, memo: label }];
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
    // Baris bahan baku: stok masuk gudang bahan baku (nilai persediaan sudah di jurnal di atas)
    const stockLines = cur.direction === "KELUAR" ? splits.filter((x) => x.itemId && Number(x.qty) > 0) : [];
    if (stockLines.length) {
      const { raw } = await locationSettings(tx);
      if (!raw) throw new FinanceError("Lokasi gudang bahan baku belum diatur di Pengaturan");
      for (const x of stockLines) {
        const qty = Number(x.qty);
        const unitCost = Math.round(Number(x.amount) / qty);
        await recordMovement(tx, { type: "PENERIMAAN", itemId: x.itemId!, qty, toLocationId: raw, unitCost, ref: cur.number, note: `Rincian ${cur.number}`, date: cur.date }, { id: actor.id, name: actor.name });
        const it = await tx.item.findUniqueOrThrow({ where: { id: x.itemId! } });
        if (!it.lastCostAt || cur.date >= it.lastCostAt) await tx.item.update({ where: { id: it.id }, data: { prevCost: it.lastCost > BigInt(0) ? it.lastCost : BigInt(unitCost), lastCost: BigInt(unitCost), lastCostAt: cur.date } });
      }
    }
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DIBUKUKAN", journalId: journal.id } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DISETUJUI_DIBUKUKAN", fromStatus: cur.status, toStatus: "DIBUKUKAN", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: note ?? `Jurnal ${journal.number}` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIBUKUKAN", "FinanceTransaction", id, { journal: journal.number, viaTelegram: actor.telegramId ?? null }, tx);
    return { transaction: t, journal };
  });
}

/**
 * Batalkan transaksi yang sudah dibukukan: jurnal asli tidak diubah, dibuat jurnal pembalik sehingga
 * saldo rekening & laba rugi kembali seperti sebelum transaksi. Pembalik bertanggal sama dengan transaksi
 * bila periodenya masih terbuka (laporan harian bersih), atau hari ini bila periodenya sudah ditutup.
 */
export async function cancelBookedTransaction(id: string, actor: Actor & { id: string }, reason: string, now: Date = new Date()) {
  if (!reason?.trim()) throw new FinanceError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status !== "DIBUKUKAN" || !cur.journalId) throw new FinanceError("Hanya transaksi berstatus Dibukukan yang dapat dibatalkan");
    const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
    const rev = await reverseJournal(tx, cur.journalId, date, { id: actor.id, name: actor.name }, `batal ${cur.number} — ${reason.trim()}`.slice(0, 150));
    // Pemasukan penjualan susulan untuk withdraw lama (skrip perbaikan) ikut dibalik
    for (const extra of await tx.journal.findMany({ where: { source: WITHDRAW_INCOME_SOURCE, sourceId: cur.id } })) {
      if (!(await tx.journal.findFirst({ where: { reversalOfId: extra.id } }))) await reverseJournal(tx, extra.id, date, { id: actor.id, name: actor.name }, `batal ${cur.number}`);
    }
    // Bahan baku dari rincian ikut dikeluarkan lagi dari gudang
    const stockIn = await tx.stockMovement.findMany({ where: { ref: cur.number, type: "PENERIMAAN" } });
    for (const m of stockIn) await recordMovement(tx, { type: "PENGELUARAN", itemId: m.itemId, qty: Number(m.qty), fromLocationId: m.toLocationId, ref: `BATAL ${cur.number}`, note: `Pembatalan ${cur.number}`, date, allowNegative: true }, { id: actor.id, name: actor.name });
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DIBATALKAN" } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIBATALKAN", fromStatus: "DIBUKUKAN", toStatus: "DIBATALKAN", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `${reason.trim()} · jurnal pembalik ${rev.number}` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIBATALKAN", "FinanceTransaction", id, { reason, reversal: rev.number }, tx);
    return { transaction: t, reversal: rev };
  });
}

/**
 * Ganti toko withdraw yang sudah dibukukan. Jurnal tidak boleh diubah, jadi jurnal lama dibalik lalu dibukukan
 * ulang dengan toko baru (tanggal & baris sama). Saldo rekening tidak berubah; hanya laporan per toko yang pindah.
 */
export async function changeBookedStore(id: string, storeId: string, actor: Actor & { id: string }, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status !== "DIBUKUKAN" || !cur.journalId) throw new FinanceError("Hanya transaksi Dibukukan yang tokonya diganti lewat menu ini; draft cukup diubah biasa");
    if (cur.direction !== "TRANSFER") throw new FinanceError("Toko hanya membedakan withdraw (transfer internal)");
    if (cur.storeId === storeId) throw new FinanceError("Toko sudah sama");
    const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
    const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
    const who = { id: actor.id, name: actor.name };
    const repost = async (journalId: string) => {
      const j = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { lines: true } });
      await reverseJournal(tx, j.id, date, who, `ganti toko ${cur.number} ke ${store.name}`);
      return postJournal(tx, { date, storeId, description: j.description, source: j.source, sourceId: j.sourceId, actor: who, lines: j.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined })) });
    };
    const main = await repost(cur.journalId);
    for (const extra of await tx.journal.findMany({ where: { source: WITHDRAW_INCOME_SOURCE, sourceId: cur.id } })) {
      if (!(await tx.journal.findFirst({ where: { reversalOfId: extra.id } }))) await repost(extra.id);
    }
    const t = await tx.financeTransaction.update({ where: { id }, data: { storeId, journalId: main.id } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `Toko diganti ke ${store.name} · jurnal ${main.number}` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_GANTI_TOKO", "FinanceTransaction", id, { from: cur.storeId, to: storeId, journal: main.number }, tx);
    return t;
  });
}

const DELETABLE: TxStatus[] = ["DIBATALKAN", "DITOLAK"];

/**
 * Hapus transaksi Dibatalkan/Ditolak dari daftar Transaksi. Tidak menyentuh saldo: transaksi ditolak tidak
 * pernah dibukukan, dan transaksi dibatalkan sudah dinetralkan jurnal pembalik (jurnal tetap tersimpan, dikunci).
 */
export async function deleteClosedTransactions(ids: string[], actor: Actor & { id: string }) {
  if (!ids.length) throw new FinanceError("Tidak ada transaksi yang dipilih");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.financeTransaction.findMany({ where: { id: { in: ids }, deletedAt: null } });
    const bad = rows.find((r) => !DELETABLE.includes(r.status));
    if (bad) throw new FinanceError(`${bad.number} berstatus ${STATUS_LABEL[bad.status]}; hanya transaksi Dibatalkan/Ditolak yang bisa dihapus`);
    if (!rows.length) throw new FinanceError("Transaksi sudah dihapus");
    await tx.financeTransaction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: new Date(), deletedBy: actor.name } });
    for (const r of rows) {
      await tx.approvalLog.create({ data: { transactionId: r.id, action: "DIHAPUS", fromStatus: r.status, toStatus: r.status, actorUserId: actor.id, actorName: actor.name, note: "Dihapus dari daftar Transaksi" } });
    }
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIHAPUS", "FinanceTransaction", rows.length === 1 ? rows[0].id : null, { numbers: rows.map((r) => r.number) }, tx);
    return rows.length;
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
