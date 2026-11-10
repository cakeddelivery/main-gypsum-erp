import { Prisma, type TxDirection, type TxSource, type TxStatus } from "@prisma/client";
import { prisma } from "./db";
import { nextNumber } from "./numbering";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
import { locationSettings, recordMovement } from "./stock";
import { audit } from "./audit";
import { addDays, dateStr, jakartaDateTime, todayStr } from "./time";
import { liabilityAccountId, payableLines, splitPayment } from "./payables";
import { applyReserveLink, parseLink, reserveAccrualLines, reserveOptions, validateLink, type ReserveLink, type ReservePart } from "./reserveSync";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string | null; name: string; telegramId?: string };

export const STATUS_LABEL: Record<TxStatus, string> = {
  DRAFT: "Draft",
  PERLU_DITINJAU: "Perlu Ditinjau",
  MENUNGGU_KONFIRMASI: "Menunggu Konfirmasi",
  DALAM_PROSES: "Dalam Proses",
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
/** Jurnal ke-2 withdraw TikTok: uang diterima (Dana dalam Perjalanan → rekening bank) */
export const WD_RECEIVED_SOURCE = "WD_DITERIMA";
/** Setting berisi kode akun COA "Dana dalam Perjalanan" (dibuat migrasi 20261111100000) */
export const TRANSIT_SETTING = "coa_dana_perjalanan";

/** Akun perantara "Dana dalam Perjalanan" (aset lancar, akun kas): WD TikTok yang sudah ditransfer tetapi belum masuk bank */
export async function transitAccount(tx: Tx | typeof prisma) {
  const code = (await tx.setting.findUnique({ where: { key: TRANSIT_SETTING } }))?.value;
  const acc = code ? await tx.coaAccount.findUnique({ where: { code } }) : await tx.coaAccount.findFirst({ where: { name: "Dana dalam Perjalanan" } });
  if (!acc) throw new FinanceError('Akun COA "Dana dalam Perjalanan" belum ada. Jalankan: npx prisma migrate deploy');
  return acc;
}

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
  /** Pengeluaran untuk membayar hutang supplier / cicilan pinjaman (pokok = nominal − bunga) */
  payableId?: string | null;
  payInterest?: number | null;
  /** Transfer dana sisihan: rincian sisihan, atau skip = transfer biasa; kosong = dicocokkan otomatis saat dibukukan */
  reserveLink?: ReserveLink | null;
  /** Pengembalian dana talangan ke dompet simpanan (bukan sisihan) */
  bailoutRepay?: boolean;
  /** Transaksi mirip yang sudah dinyatakan pengguna "berbeda, tetap simpan" */
  dupAckIds?: string[] | null;
  /** Withdraw TikTok: No. Referensi Seller Center (sama = duplikat pasti) */
  withdrawRef?: string | null;
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

export { fingerprint } from "./txMirror";
import { fingerprint } from "./txMirror";
import { nextTxNumber, originLabel } from "./txMirror";
import { findSimilar } from "./similar";

/** Baris tertaut dari menu lain hanya-baca di menu Transaksi: ubah/batalkan di menu sumbernya */
export function assertOwnTransaction(cur: { origin: string | null; number: string; direction?: string }) {
  if (cur.origin) throw new FinanceError(`${cur.number} berasal dari ${originLabel(cur.origin, cur.direction)} (menu ${originLabel(cur.origin)}). Ubah atau batalkan di menu tersebut agar stok, hutang & dokumennya ikut menyesuaikan.`);
}

/**
 * Transaksi lain yang mirip (lihat findSimilar): dipakai menandai duplikat (duplicateOfId → Perlu Ditinjau).
 * Transaksi yang sudah dinyatakan berbeda (dupAckIds) tidak ditandai lagi.
 */
export async function findDuplicate(tx: Tx | typeof prisma, input: { direction: TxDirection; amount: number; date: Date; accountId?: string | null; toAccountId?: string | null; categoryId?: string | null; note?: string | null; counterparty?: string | null; rawText?: string | null; reserveLink?: unknown; withdrawRef?: string | null }, excludeId?: string, ack: string[] = []) {
  const link = "reserveLink" in input ? parseLink(input.reserveLink) : null;
  const reserveParts = link && "parts" in link ? link.parts : undefined;
  const hits = await findSimilar(tx, { ...input, reserveParts, text: [input.note, input.counterparty, input.rawText].filter(Boolean).join(" "), excludeIds: [...(excludeId ? [excludeId] : []), ...ack] }, 1);
  return hits[0] ?? null;
}

export function missingFields(t: { direction: TxDirection; amount: number | bigint; accountId?: string | null; toAccountId?: string | null; categoryId?: string | null; storeId?: string | null; payableId?: string | null }) {
  const m: string[] = [];
  if (!t.amount || Number(t.amount) <= 0) m.push("nominal");
  if (!t.accountId) m.push("rekening");
  if (!t.storeId) m.push("toko");
  if (t.direction === "TRANSFER") {
    if (!t.toAccountId) m.push("rekening tujuan");
    else if (t.toAccountId === t.accountId) m.push("rekening tujuan harus berbeda");
  } else if (!t.categoryId && !t.payableId) m.push("kategori");
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
    if (input.direction === "KELUAR" && input.payableId && !splits.length) {
      // Bayar hutang / cicilan: kategori tidak dipakai (jurnal ke akun hutangnya)
      const p = await tx.payable.findUniqueOrThrow({ where: { id: input.payableId } });
      if (p.paid >= p.amount) throw new FinanceError(`Hutang ${p.number} sudah lunas`);
      input.categoryId = null;
    } else input.payableId = null;
    const dup = await findDuplicate(tx, input, undefined, input.dupAckIds ?? []);
    const missing = [...missingFields(input), ...splitIssues(input.amount, input.direction, splits)];
    let status: TxStatus = "DRAFT";
    if (source !== "MANUAL" || opts.submit) status = dup || missing.length ? "PERLU_DITINJAU" : "MENUNGGU_KONFIRMASI";
    const number = await nextTxNumber(tx, input.date);
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
        withdrawRef: input.withdrawRef ?? null,
        status,
        fingerprint: fingerprint(input.direction, input.amount, input.date, input.accountId),
        duplicateOfId: dup?.id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: actor.name,
        telegramChatId: input.telegramChatId ?? null,
        telegramMessageId: input.telegramMessageId ?? null,
        splits: splits.length ? { create: splitRows(splits) } : undefined,
        payableId: input.direction === "KELUAR" && !splits.length ? input.payableId ?? null : null,
        payInterest: BigInt(input.direction === "KELUAR" && input.payableId ? Math.max(0, Math.round(input.payInterest ?? 0)) : 0),
        reserveLink: input.direction === "TRANSFER" && input.reserveLink ? (input.reserveLink as Prisma.InputJsonValue) : undefined,
        bailoutRepay: input.direction === "TRANSFER" && !!input.bailoutRepay,
        dupAckIds: input.dupAckIds ?? [],
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
      payableId: input.payableId !== undefined ? input.payableId : cur.payableId,
    };
    if (merged.direction !== "KELUAR") merged.payableId = null;
    if (merged.payableId) merged.categoryId = null;
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
    const dup = await findDuplicate(tx, { ...merged, note: input.note !== undefined ? input.note : cur.note, counterparty: cur.counterparty, rawText: cur.rawText }, id, cur.dupAckIds);
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
        payInterest: merged.payableId ? (input.payInterest != null ? BigInt(Math.max(0, Math.round(input.payInterest))) : undefined) : BigInt(0),
        reserveLink: merged.direction !== "TRANSFER" ? Prisma.DbNull : input.reserveLink !== undefined ? (input.reserveLink ? (input.reserveLink as Prisma.InputJsonValue) : Prisma.DbNull) : undefined,
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
    if (cur.status === "DALAM_PROSES") throw new FinanceError("Withdraw Dalam Proses sudah berjurnal (penjualan diakui): gunakan Batalkan agar jurnalnya dibalik");
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
  return prisma.$transaction((tx) => bookInTx(tx, id, actor, note));
}

type TxRow = Prisma.FinanceTransactionGetPayload<object>;

/** Baris jurnal transaksi (rekening ↔ kategori / rincian / hutang). Hutang: Dr Hutang pokok + Dr Beban Bunga / Cr rekening */
async function txJournalLines(tx: Tx, cur: TxRow, reserveParts: ReservePart[] = [], opts: { transitId?: string } = {}): Promise<LineInput[]> {
  const splits = await tx.financeTxSplit.findMany({ where: { transactionId: cur.id }, orderBy: { sortOrder: "asc" } });
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.accountId! } });
  const amount = Number(cur.amount);
  if (cur.payableId) {
    const p = await tx.payable.findUniqueOrThrow({ where: { id: cur.payableId } });
    const interest = Number(cur.payInterest);
    return payableLines(await liabilityAccountId(tx, p), bank.coaAccountId, amount - interest, interest, `${p.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang"} ${p.number} ${p.vendor}`.slice(0, 120));
  }
  if (cur.direction === "TRANSFER") {
    const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.toAccountId! } });
    // Transfer internal: hanya memindahkan saldo antar rekening (bukan pendapatan/beban)
    // WD TikTok Dalam Proses: tujuan sementara = Dana dalam Perjalanan (masuk bank saat "Uang diterima")
    const lines: LineInput[] = opts.transitId
      ? [
          { accountId: opts.transitId, debit: amount, memo: `Dana dalam perjalanan ke ${to.name}` },
          { accountId: bank.coaAccountId, credit: amount, memo: `Withdraw ke ${to.name} (dalam proses)` },
        ]
      : [
          { accountId: to.coaAccountId, debit: amount, memo: `Transfer dari ${bank.name}` },
          { accountId: bank.coaAccountId, credit: amount, memo: `Transfer ke ${to.name}` },
        ];
    // Withdraw saldo penjual marketplace = hasil penjualan di Shopee/TikTok: sekaligus dicatat sebagai pemasukan
    // (Dr Saldo Penjual / Cr Penjualan), sehingga saldo penjual tidak minus dan omzet toko tercatat
    if (bank.marketplace) lines.unshift(...withdrawIncomeLines(bank.coaAccountId, bank.name, amount));
    // Transfer dana sisihan kompensasi owner: sekaligus dicatat sebagai beban kompensasi (titipan owner)
    lines.push(...(await reserveAccrualLines(tx, reserveParts)));
    return lines;
  }
  if (splits.length) {
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
    return cur.direction === "MASUK" ? [{ accountId: bank.coaAccountId, debit: amount, memo: label }, ...parts] : [...parts, { accountId: bank.coaAccountId, credit: amount, memo: label }];
  }
  const cat = await tx.txCategory.findUniqueOrThrow({ where: { id: cur.categoryId! } });
  if (cat.direction !== cur.direction) throw new FinanceError("Kategori tidak sesuai jenis transaksi");
  return cur.direction === "MASUK"
    ? [
        { accountId: bank.coaAccountId, debit: amount, memo: cat.name },
        { accountId: cat.coaAccountId, credit: amount, memo: cur.note ?? undefined },
      ]
    : [
        { accountId: cat.coaAccountId, debit: amount, memo: cur.note ?? undefined },
        { accountId: bank.coaAccountId, credit: amount, memo: cat.name },
      ];
}

/** Pokok hutang yang dibayar transaksi ini ditambahkan (sign 1) / dikembalikan (sign -1) ke hutangnya */
async function applyPayable(tx: Tx, cur: Pick<TxRow, "payableId" | "amount" | "payInterest">, sign: 1 | -1) {
  if (!cur.payableId) return;
  const principal = Number(cur.amount) - Number(cur.payInterest);
  const p = await tx.payable.findUniqueOrThrow({ where: { id: cur.payableId } });
  if (sign === 1) {
    const rem = Number(p.amount - p.paid);
    if (!(principal > 0)) throw new FinanceError("Pokok pembayaran harus > 0 (bunga tidak boleh ≥ nominal)");
    if (principal > rem) throw new FinanceError(`Pokok ${principal.toLocaleString("id-ID")} melebihi sisa hutang ${p.number} (${rem.toLocaleString("id-ID")})`);
  }
  await tx.payable.update({ where: { id: p.id }, data: { paid: { increment: BigInt(sign * principal) } } });
}

/**
 * Pembayaran hutang dari rekening simpanan dana sisihan (Tabungan cicilan pinjaman, mis. Seabank 0006):
 * saldo tabungannya ikut berkurang (catatan TARIK tanpa jurnal tambahan; jurnalnya = jurnal transaksi ini).
 */
async function syncLoanSaving(tx: Tx, cur: Pick<TxRow, "payableId" | "accountId" | "amount" | "date" | "number">, journalId: string, actorName: string) {
  if (!cur.payableId || !cur.accountId) return;
  if ((await tx.payable.findUnique({ where: { id: cur.payableId } }))?.kind !== "PINJAMAN") return;
  const funds = await tx.reserveFund.findMany({ where: { kind: "LOAN_SAVING", toBankId: cur.accountId }, orderBy: [{ active: "desc" }, { createdAt: "asc" }] });
  let left = Number(cur.amount);
  for (const f of funds) {
    if (left <= 0) break;
    const sums = await tx.reserveEntry.groupBy({ by: ["type"], where: { fundId: f.id }, _sum: { amount: true } });
    const bal = Number(sums.find((r) => r.type === "SISIH")?._sum.amount ?? 0) - Number(sums.find((r) => r.type === "TARIK")?._sum.amount ?? 0);
    const take = Math.min(left, bal);
    if (take <= 0) continue;
    await tx.reserveEntry.create({ data: { fundId: f.id, date: new Date(`${dateStr(cur.date)}T00:00:00Z`), type: "TARIK", amount: BigInt(take), journalId, note: `Bayar hutang ${cur.number}`, createdBy: actorName } });
    left -= take;
  }
}

/**
 * Dana sisihan untuk transfer yang akan dibukukan: rincian yang sudah dipilih (dicek ulang), atau dicocokkan
 * otomatis dari rekening & nominal bila hasilnya cukup yakin. Transfer biasa / tidak cocok = tanpa sisihan.
 */
async function resolveReserveLink(tx: Tx, cur: TxRow): Promise<ReservePart[]> {
  if (cur.direction !== "TRANSFER" || !cur.accountId || !cur.toAccountId || cur.bailoutRepay) return [];
  const link = parseLink(cur.reserveLink);
  if (link && "skip" in link) return [];
  if (link) {
    await validateLink(tx, cur, link.parts).catch((e) => {
      throw new FinanceError(e instanceof Error ? e.message : String(e));
    });
    return link.parts;
  }
  const text = [cur.note, cur.rawText, cur.counterparty].filter(Boolean).join(" ");
  // "kembalikan talangan" = pengembalian dana talangan, bukan sisihan
  if (/\btalangan\b/i.test(text)) return [];
  const m = await reserveOptions(tx, { amount: Number(cur.amount), fromBankId: cur.accountId, toBankId: cur.toAccountId, date: todayStr(cur.date), text, excludeTxId: cur.id });
  return m?.sure ? m.options[0].parts : [];
}

async function bookInTx(tx: Tx, id: string, actor: Actor & { id: string }, note?: string) {
  {
    // Kunci baris untuk mencegah pembukuan ganda saat konfirmasi bersamaan
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status === "DIBUKUKAN") throw new FinanceError("Transaksi sudah dibukukan");
    if (cur.status === "DALAM_PROSES") throw new FinanceError("Withdraw ini masih Dalam Proses: tekan \"Uang diterima\" setelah uangnya masuk rekening");
    if (cur.status !== "MENUNGGU_KONFIRMASI") throw new FinanceError("Hanya transaksi berstatus Menunggu Konfirmasi yang dapat dibukukan");
    const splits = await tx.financeTxSplit.findMany({ where: { transactionId: id }, orderBy: { sortOrder: "asc" } });
    const missing = [...missingFields(cur), ...splitIssues(cur.amount, cur.direction, splits)];
    if (missing.length) throw new FinanceError(`Data belum lengkap: ${missing.join(", ")}`);
    const reserveParts = await resolveReserveLink(tx, cur);
    if (reserveParts.length) await tx.financeTransaction.update({ where: { id }, data: { reserveLink: { parts: reserveParts } as Prisma.InputJsonValue } });
    const lines = await txJournalLines(tx, cur, reserveParts);
    await applyPayable(tx, cur, 1);
    const journal = await postJournal(tx, {
      date: cur.date,
      storeId: cur.storeId!,
      description: `${cur.number} ${cur.note ?? ""}`.trim().slice(0, 200),
      source: "FINANCE",
      sourceId: cur.id,
      actor: { id: actor.id, name: actor.name },
      lines,
    });
    await syncLoanSaving(tx, cur, journal.id, actor.name);
    if (reserveParts.length) await applyReserveLink(tx, cur, reserveParts, journal.id, { id: actor.id, name: actor.name });
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
  }
}

/**
 * Jurnal 1 withdraw TikTok (status Dalam Proses), bertanggal transfer: pemasukan penjualan (Dr Saldo Penjual /
 * Cr Penjualan) + Dr Dana dalam Perjalanan / Cr Saldo Penjual. Rekening bank belum berubah.
 */
export async function postWdSent(tx: Tx, cur: TxRow, actor: Actor & { id: string }) {
  const transit = await transitAccount(tx);
  const lines = await txJournalLines(tx, cur, [], { transitId: transit.id });
  return postJournal(tx, { date: cur.date, storeId: cur.storeId!, description: `${cur.number} ${cur.note ?? ""}`.trim().slice(0, 200), source: "FINANCE", sourceId: cur.id, actor: { id: actor.id, name: actor.name }, lines });
}

/** Jurnal 2 withdraw TikTok ("Uang diterima"), bertanggal terima: Dr rekening bank / Cr Dana dalam Perjalanan */
export async function postWdReceived(tx: Tx, cur: TxRow, toAccountId: string, date: Date, actor: Actor & { id: string }) {
  const transit = await transitAccount(tx);
  const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: toAccountId } });
  const amount = Number(cur.amount);
  return postJournal(tx, {
    date,
    storeId: cur.storeId!,
    description: `${cur.number} uang diterima ${to.name}`.slice(0, 200),
    source: WD_RECEIVED_SOURCE,
    sourceId: cur.id,
    actor: { id: actor.id, name: actor.name },
    lines: [
      { accountId: to.coaAccountId, debit: amount, memo: `Withdraw ${cur.number} diterima` },
      { accountId: transit.id, credit: amount, memo: `Dana dalam perjalanan → ${to.name}` },
    ],
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
    assertOwnTransaction(cur);
    if ((cur.status !== "DIBUKUKAN" && cur.status !== "DALAM_PROSES") || !cur.journalId) throw new FinanceError("Hanya transaksi berstatus Dibukukan / Dalam Proses yang dapat dibatalkan");
    const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
    const rev = await reverseJournal(tx, cur.journalId, date, { id: actor.id, name: actor.name }, `batal ${cur.number} — ${reason.trim()}`.slice(0, 150));
    // Pembayaran hutang dibatalkan: sisa hutangnya kembali, saldo tabungan cicilan juga
    await applyPayable(tx, cur, -1);
    await tx.reserveEntry.deleteMany({ where: { journalId: cur.journalId, type: "TARIK" } });
    // Sisihan yang dicatat dari transfer ini ikut batal (jurnalnya sudah dibalik di atas)
    await tx.reserveEntry.deleteMany({ where: { transactionId: cur.id, type: "SISIH" } });
    // Pemasukan penjualan susulan untuk withdraw lama (skrip perbaikan) ikut dibalik
    // Withdraw TikTok: jurnal "uang diterima" (Dana dalam Perjalanan → bank) ikut dibalik
    for (const extra of await tx.journal.findMany({ where: { source: { in: [WITHDRAW_INCOME_SOURCE, WD_RECEIVED_SOURCE] }, sourceId: cur.id, reversalOfId: null } })) {
      if (!(await tx.journal.findFirst({ where: { reversalOfId: extra.id } }))) {
        const d = extra.source === WD_RECEIVED_SOURCE ? await assertPeriodOpen(tx, extra.date).then(() => extra.date, () => now) : date;
        await reverseJournal(tx, extra.id, d, { id: actor.id, name: actor.name }, `batal ${cur.number}`);
      }
    }
    // Bahan baku dari rincian ikut dikeluarkan lagi dari gudang
    const stockIn = await tx.stockMovement.findMany({ where: { ref: cur.number, type: "PENERIMAAN" } });
    for (const m of stockIn) await recordMovement(tx, { type: "PENGELUARAN", itemId: m.itemId, qty: Number(m.qty), fromLocationId: m.toLocationId, ref: `BATAL ${cur.number}`, note: `Pembatalan ${cur.number}`, date, allowNegative: true, noJournal: true }, { id: actor.id, name: actor.name });
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DIBATALKAN" } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIBATALKAN", fromStatus: cur.status, toStatus: "DIBATALKAN", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `${reason.trim()} · jurnal pembalik ${rev.number}` } });
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
    assertOwnTransaction(cur);
    if ((cur.status !== "DIBUKUKAN" && cur.status !== "DALAM_PROSES") || !cur.journalId) throw new FinanceError("Hanya transaksi Dibukukan / Dalam Proses yang tokonya diganti lewat menu ini; draft cukup diubah biasa");
    if (cur.direction !== "TRANSFER") throw new FinanceError("Toko hanya membedakan withdraw (transfer internal)");
    if (cur.storeId === storeId) throw new FinanceError("Toko sudah sama");
    const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
    const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
    const who = { id: actor.id, name: actor.name };
    const repost = async (journalId: string) => {
      const j = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { lines: true } });
      // Jurnal "uang diterima" tetap bertanggal terima (bila periodenya masih terbuka)
      const d = j.source === WD_RECEIVED_SOURCE ? await assertPeriodOpen(tx, j.date).then(() => j.date, () => now) : date;
      await reverseJournal(tx, j.id, d, who, `ganti toko ${cur.number} ke ${store.name}`);
      return postJournal(tx, { date: d, storeId, description: j.description, source: j.source, sourceId: j.sourceId, actor: who, lines: j.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined })) });
    };
    const main = await repost(cur.journalId);
    for (const extra of await tx.journal.findMany({ where: { source: { in: [WITHDRAW_INCOME_SOURCE, WD_RECEIVED_SOURCE] }, sourceId: cur.id, reversalOfId: null } })) {
      if (!(await tx.journal.findFirst({ where: { reversalOfId: extra.id } }))) await repost(extra.id);
    }
    const t = await tx.financeTransaction.update({ where: { id }, data: { storeId, journalId: main.id } });
    await tx.reserveEntry.updateMany({ where: { transactionId: id }, data: { journalId: main.id } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `Toko diganti ke ${store.name} · jurnal ${main.number}` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_GANTI_TOKO", "FinanceTransaction", id, { from: cur.storeId, to: storeId, journal: main.number }, tx);
    return t;
  });
}

export type Reclass = { categoryId: string } | { payableId: string; interest?: number | null } | { accountId: string };

/**
 * Ubah pencatatan transaksi yang sudah dibukukan: pindah kategori, atau jadikan pembayaran hutang / cicilan pinjaman
 * (pokok mengurangi hutang, bunga ke Beban Bunga & Biaya Pinjaman). Jurnal lama dibalik lalu dibukukan ulang;
 * saldo rekening tidak berubah.
 */
export async function reclassifyBooked(id: string, target: Reclass, actor: Actor & { id: string }, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    assertOwnTransaction(cur);
    if (cur.status !== "DIBUKUKAN" || !cur.journalId) throw new FinanceError("Hanya transaksi Dibukukan yang diubah lewat menu ini; draft cukup diubah biasa");
    if (cur.direction === "TRANSFER") throw new FinanceError("Transfer antar rekening tidak berkategori");
    if (!("accountId" in target) && (await tx.financeTxSplit.count({ where: { transactionId: id } }))) throw new FinanceError("Transaksi ini punya rincian; batalkan lalu catat ulang bila rinciannya perlu diubah");
    let data: { categoryId: string | null; payableId: string | null; payInterest: bigint } | { accountId: string };
    let label: string;
    if ("accountId" in target) {
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: target.accountId } });
      if (!bank.active) throw new FinanceError("Rekening tidak aktif");
      if (cur.accountId === bank.id) throw new FinanceError("Rekening sudah sama");
      data = { accountId: bank.id };
      label = `Rekening: ${bank.name}`;
    } else if ("categoryId" in target) {
      const cat = await tx.txCategory.findUniqueOrThrow({ where: { id: target.categoryId } });
      if (cat.direction !== cur.direction) throw new FinanceError("Kategori tidak sesuai jenis transaksi");
      if (cur.categoryId === cat.id && !cur.payableId) throw new FinanceError("Kategori sudah sama");
      data = { categoryId: cat.id, payableId: null, payInterest: BigInt(0) };
      label = `Kategori: ${cat.name}`;
    } else {
      if (cur.direction !== "KELUAR") throw new FinanceError("Pembayaran hutang harus transaksi keluar");
      const p = await tx.payable.findUniqueOrThrow({ where: { id: target.payableId } });
      // Pokok yang sudah tercatat dari transaksi ini (bila dipindah antar cicilan hutang yang sama) tidak dihitung dua kali
      const base = cur.payableId === p.id ? { ...p, paid: p.paid - (cur.amount - cur.payInterest) } : p;
      const sp = splitPayment(base, Number(cur.amount), target.interest);
      if (sp.interest < 0 || sp.principal <= 0) throw new FinanceError("Bunga harus 0 – kurang dari nominal");
      data = { categoryId: null, payableId: p.id, payInterest: BigInt(sp.interest) };
      label = `${p.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang"} ${p.number} ${p.vendor} (pokok ${sp.principal.toLocaleString("id-ID")}${sp.interest ? `, bunga ${sp.interest.toLocaleString("id-ID")}` : ""})`;
    }
    const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
    const who = { id: actor.id, name: actor.name };
    await reverseJournal(tx, cur.journalId, date, who, `ubah pencatatan ${cur.number}`);
    await applyPayable(tx, cur, -1);
    await tx.reserveEntry.deleteMany({ where: { journalId: cur.journalId, type: "TARIK" } });
    const updated = await tx.financeTransaction.update({ where: { id }, data });
    const lines = await txJournalLines(tx, updated);
    await applyPayable(tx, updated, 1);
    const j = await postJournal(tx, { date, storeId: cur.storeId!, description: `${cur.number} ${cur.note ?? ""}`.trim().slice(0, 200), source: "FINANCE", sourceId: cur.id, actor: who, lines });
    const t = await tx.financeTransaction.update({ where: { id }, data: { journalId: j.id } });
    await syncLoanSaving(tx, updated, j.id, actor.name);
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `${label} · jurnal ${j.number}`.slice(0, 300) } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DIKLASIFIKASI_ULANG", "FinanceTransaction", id, { before: { categoryId: cur.categoryId, payableId: cur.payableId, accountId: cur.accountId }, after: data, journal: j.number }, tx);
    return t;
  });
}

export type PayablePaymentInput = {
  payableId: string;
  /** Total ditransfer (pokok + bunga) */
  amount: number;
  /** Bunga/biaya; kosong = dari jadwal cicilan bila nominal sama dengan cicilan, selain itu 0 */
  interest?: number | null;
  bankAccountId: string;
  date: Date;
  note?: string | null;
  counterparty?: string | null;
  rawText?: string | null;
  proofPath?: string | null;
  proofMime?: string | null;
  aiExtraction?: Prisma.InputJsonValue | null;
  idempotencyKey?: string | null;
  telegramChatId?: string | null;
  telegramMessageId?: string | null;
};

/**
 * Bayar hutang supplier / cicilan pinjaman sekaligus tercatat di menu Transaksi (dengan bukti) dan langsung dibukukan.
 * Dipanggil setelah konfirmasi pengguna berwenang (web Akuntansi › Bayar, atau tombol Simpan di bot).
 */
export async function bookPayablePayment(input: PayablePaymentInput, source: TxSource, actor: Actor & { id: string }) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new FinanceError("Nominal harus bilangan bulat rupiah > 0");
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.financeTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) throw new FinanceError(`Pesan ini sudah tercatat sebagai ${existing.number}`);
    }
    await tx.$queryRaw`SELECT id FROM "Payable" WHERE id = ${input.payableId} FOR UPDATE`;
    const p = await tx.payable.findUniqueOrThrow({ where: { id: input.payableId } });
    const sp = splitPayment(p, input.amount, input.interest);
    if (sp.interest < 0 || sp.principal <= 0) throw new FinanceError("Bunga harus 0 – kurang dari nominal");
    const number = await nextTxNumber(tx, input.date);
    const kindLabel = p.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang";
    const t = await tx.financeTransaction.create({
      data: {
        number,
        source,
        direction: "KELUAR",
        amount: BigInt(input.amount),
        date: input.date,
        accountId: input.bankAccountId,
        storeId: p.storeId,
        payableId: p.id,
        payInterest: BigInt(sp.interest),
        counterparty: input.counterparty ?? p.vendor,
        note: input.note?.trim() || `${kindLabel} ${p.number} ${p.vendor}`,
        rawText: input.rawText ?? null,
        proofPath: input.proofPath ?? null,
        proofMime: input.proofMime ?? null,
        aiExtraction: input.aiExtraction ?? undefined,
        status: "MENUNGGU_KONFIRMASI",
        fingerprint: fingerprint("KELUAR", input.amount, input.date, input.bankAccountId),
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: actor.name,
        telegramChatId: input.telegramChatId ?? null,
        telegramMessageId: input.telegramMessageId ?? null,
      },
    });
    await tx.approvalLog.create({ data: { transactionId: t.id, action: "DIBUAT", toStatus: "MENUNGGU_KONFIRMASI", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `${kindLabel} ${p.number}` } });
    const r = await bookInTx(tx, t.id, actor, `${kindLabel} ${p.number}`);
    return { ...r, principal: sp.principal, interest: sp.interest, remaining: Number(p.amount - p.paid) - sp.principal };
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

/** Tampilkan lagi transaksi Dibatalkan/Ditolak yang pernah disembunyikan dari daftar Transaksi */
export async function restoreClosedTransactions(ids: string[], actor: Actor & { id: string }) {
  if (!ids.length) throw new FinanceError("Tidak ada transaksi yang dipilih");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.financeTransaction.findMany({ where: { id: { in: ids }, deletedAt: { not: null } } });
    if (!rows.length) throw new FinanceError("Transaksi sudah tampil di daftar");
    await tx.financeTransaction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: null, deletedBy: null } });
    for (const r of rows) {
      await tx.approvalLog.create({ data: { transactionId: r.id, action: "DITAMPILKAN_LAGI", fromStatus: r.status, toStatus: r.status, actorUserId: actor.id, actorName: actor.name, note: "Ditampilkan lagi di daftar Transaksi" } });
    }
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_DITAMPILKAN_LAGI", "FinanceTransaction", rows.length === 1 ? rows[0].id : null, { numbers: rows.map((r) => r.number) }, tx);
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

/**
 * Hubungkan transfer yang SUDAH dibukukan ke dana sisihan (data lama / salah rekening tujuan): jurnal lama dibalik
 * lalu dibukukan ulang dengan rekening tujuan yang benar + beban kompensasi owner, sisihannya dicatat dengan bukti
 * transfer ini. `parts` kosong = dicocokkan otomatis (harus cukup yakin).
 */
export async function linkBookedTransfer(id: string, opts: { parts?: ReservePart[] | null; toAccountId?: string | null }, actor: Actor & { id: string }, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    assertOwnTransaction(cur);
    if (cur.status !== "DIBUKUKAN" || !cur.journalId) throw new FinanceError("Hanya transaksi Dibukukan; transaksi lain otomatis dicocokkan saat dibukukan");
    if (cur.sentAt) throw new FinanceError("Withdraw TikTok (lewat Dana dalam Perjalanan) tidak bisa dijadikan dana sisihan");
    // Pengeluaran yang sebenarnya pindah ke rekening simpanan (mis. "nabung spinjam" tercatat sebagai keluar) diubah jadi transfer
    const convert = cur.direction === "KELUAR";
    if (cur.direction !== "TRANSFER" && !convert) throw new FinanceError("Hanya transfer antar rekening yang bisa menjadi sisihan");
    if (convert && (!opts.toAccountId || cur.payableId || (await tx.financeTxSplit.count({ where: { transactionId: id } })))) throw new FinanceError("Pengeluaran ini tidak bisa diubah jadi transfer sisihan (perlu rekening tujuan, tanpa rincian/hutang)");
    if (await tx.reserveEntry.count({ where: { transactionId: id } })) throw new FinanceError(`${cur.number} sudah tercatat di dana sisihan`);
    const toAccountId = opts.toAccountId ?? cur.toAccountId;
    if (!toAccountId || toAccountId === cur.accountId) throw new FinanceError("Rekening tujuan tidak valid");
    const next = { ...cur, toAccountId, direction: "TRANSFER" as const, categoryId: null };
    let parts = opts.parts ?? null;
    if (!parts?.length) {
      const m = await reserveOptions(tx, { amount: Number(cur.amount), fromBankId: cur.accountId, toBankId: toAccountId, date: todayStr(cur.date), text: [cur.note, cur.rawText, cur.counterparty].filter(Boolean).join(" "), excludeTxId: cur.id });
      if (!m) throw new FinanceError("Tidak ada dana sisihan yang cocok dengan rekening & nominal transfer ini");
      if (!m.sure) throw new FinanceError(`Dana sisihan belum pasti, pilih salah satu: ${m.options.map((o) => o.label).join(" / ")}`);
      parts = m.options[0].parts;
    }
    await validateLink(tx, next, parts).catch((e) => {
      throw new FinanceError(e instanceof Error ? e.message : String(e));
    });
    const who = { id: actor.id, name: actor.name };
    let journalId = cur.journalId;
    const accrual = await reserveAccrualLines(tx, parts);
    if (accrual.length || convert || toAccountId !== cur.toAccountId) {
      // Jurnal tidak boleh diubah: dibalik lalu dibukukan ulang (tanggal sama bila periodenya masih terbuka)
      const date = await assertPeriodOpen(tx, cur.date).then(() => cur.date, () => now);
      await reverseJournal(tx, cur.journalId, date, who, `sinkron dana sisihan ${cur.number}`);
      const lines = await txJournalLines(tx, next, parts);
      const j = await postJournal(tx, { date, storeId: cur.storeId!, description: `${cur.number} ${cur.note ?? ""}`.trim().slice(0, 200), source: "FINANCE", sourceId: cur.id, actor: who, lines });
      journalId = j.id;
    }
    await tx.financeTransaction.update({ where: { id }, data: { toAccountId, journalId, direction: "TRANSFER", categoryId: null, reserveLink: { parts } as Prisma.InputJsonValue } });
    const r = await applyReserveLink(tx, cur, parts, journalId, who, now);
    const note = `Dana sisihan: ${r.created + r.absorbed} sisihan${convert ? " · diubah dari pengeluaran jadi transfer" : ""}${toAccountId !== cur.toAccountId ? " · rekening tujuan dibetulkan" : ""} · jurnal ${journalId === cur.journalId ? "tetap" : "baru"}`;
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, note } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_SINKRON_SISIHAN", "FinanceTransaction", id, { parts, toAccountId, ...r }, tx);
    return { ...r, journalId, toAccountId };
  });
}

/** Pilih dana sisihan untuk transfer yang belum dibukukan (parts), tandai transfer biasa (skip), atau kembali otomatis (null) */
export async function setReserveLink(id: string, link: ReserveLink | null, actor: Actor) {
  const cur = await prisma.financeTransaction.findUniqueOrThrow({ where: { id } });
  if (!EDITABLE.includes(cur.status)) throw new FinanceError("Transaksi sudah final");
  if (cur.direction !== "TRANSFER") throw new FinanceError("Hanya transfer antar rekening");
  if (link && "parts" in link) await validateLink(prisma, cur, link.parts).catch((e) => {
    throw new FinanceError(e instanceof Error ? e.message : String(e));
  });
  await prisma.financeTransaction.update({ where: { id }, data: { reserveLink: link ? (link as Prisma.InputJsonValue) : Prisma.DbNull } });
  await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_PILIH_SISIHAN", "FinanceTransaction", id, { link });
}

/**
 * Lampirkan bukti ke transaksi (status apa pun, termasuk Dibukukan: tidak mengubah jurnal) dan ke dokumen yang
 * tersambung: sisihan dari transfer ini.
 */
export async function attachTransactionProof(id: string, proof: { path: string; mime: string }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    await tx.financeTransaction.update({ where: { id }, data: { proofPath: proof.path, proofMime: proof.mime } });
    const r = await tx.reserveEntry.updateMany({ where: { transactionId: id, proofPath: cur.proofPath ?? null }, data: { proofPath: proof.path, proofMime: proof.mime } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DIUBAH", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, note: "Bukti dilampirkan" } });
    await audit({ actorId: actor.id, actorName: actor.name }, "TRANSAKSI_BUKTI", "FinanceTransaction", id, { sisihan: r.count }, tx);
    return r.count;
  });
}

/**
 * Bukti transfer dana sisihan dari bot/web: dicatat sebagai transfer di menu Transaksi (dengan bukti) lalu langsung
 * dibukukan bersama sisihannya. Bila terindikasi duplikat, transaksi berhenti di Perlu Ditinjau.
 */
export async function bookReserveTransfer(input: TxInput, parts: ReservePart[], source: TxSource, actor: Actor & { id: string }) {
  if (!parts.length) throw new FinanceError("Pilih dana sisihan");
  const fund = await prisma.reserveFund.findUniqueOrThrow({ where: { id: parts[0].fundId } });
  const data: TxInput = { ...input, direction: "TRANSFER", accountId: input.accountId ?? fund.fromBankId, toAccountId: fund.toBankId, categoryId: null, suggestedCategoryId: null, splits: null, payableId: null, askStore: false, reserveLink: { parts } };
  const r = await createTransaction(data, source, actor, { submit: true });
  if (r.replayed) return { transaction: r.transaction, booked: r.transaction.status === "DIBUKUKAN", duplicate: null };
  if (r.transaction.status !== "MENUNGGU_KONFIRMASI") return { transaction: r.transaction, booked: false, duplicate: r.duplicate };
  const b = await approveAndBook(r.transaction.id, actor, "Transfer dana sisihan");
  return { transaction: b.transaction, booked: true, duplicate: null };
}
