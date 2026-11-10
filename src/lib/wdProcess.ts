import { prisma } from "./db";
import { approveAndBook, FinanceError, missingFields, postWdReceived, postWdSent, type Actor } from "./finance";
import { audit } from "./audit";
import { idr } from "./money";
import { fmtDateTime, jakartaDateTime, nowTimeStr } from "./time";
import { checkWdProof, sellerProofRead, type SellerWithdrawal, type WdProofRead } from "./wdProof";

/**
 * Withdraw TikTok "Dalam Proses" (pelajaran audit 9 Nov: dana WD TikTok baru masuk SeaBank 1–3 hari setelah
 * "Ditransfer ke bank"). Saldo rekening ERP harus selalu sama dengan bank. Keputusan owner (10 Nov): penjualan
 * diakui sejak ditransfer, lewat akun perantara "Dana dalam Perjalanan":
 * - Konfirmasi WD dari Saldo Penjual TikTok → status DALAM_PROSES + jurnal 1 bertanggal transfer:
 *   Dr Saldo Penjual / Cr Penjualan, Dr Dana dalam Perjalanan / Cr Saldo Penjual. Rekening bank belum berubah.
 * - "Uang diterima" → jurnal 2 bertanggal terima: Dr rekening bank / Cr Dana dalam Perjalanan → DIBUKUKAN.
 * - Batal di tahap mana pun membalik jurnal yang sudah ada (cancelBookedTransaction).
 * Shopee tidak berubah (dana Shopee langsung masuk saat ditarik).
 */

type BankLike = { name: string; aliases?: string | null; marketplace: boolean };

/** Rekening Saldo Penjual TikTok Shop / Tokopedia */
export function isTiktokSeller(b: BankLike | null | undefined) {
  return !!b?.marketplace && /tik ?tok|tokopedia/i.test(`${b.name} ${b.aliases ?? ""}`);
}

/** Transaksi = withdraw dari Saldo Penjual TikTok (transfer dari rekening saldo penjual TikTok ke bank) */
export async function isTiktokWithdraw(t: { direction: string; accountId: string | null }) {
  if (t.direction !== "TRANSFER" || !t.accountId) return false;
  return isTiktokSeller(await prisma.bankAccount.findUnique({ where: { id: t.accountId } }));
}

/** Konfirmasi WD TikTok: Menunggu Konfirmasi → Dalam Proses + jurnal 1 (penjualan diakui, dana dalam perjalanan) */
export async function markInProcess(id: string, actor: Actor & { id: string }, note?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status === "DALAM_PROSES") throw new FinanceError("Withdraw ini sudah Dalam Proses");
    if (cur.status !== "MENUNGGU_KONFIRMASI") throw new FinanceError("Hanya transaksi berstatus Menunggu Konfirmasi yang dapat dikonfirmasi");
    const missing = missingFields(cur);
    if (missing.length) throw new FinanceError(`Data belum lengkap: ${missing.join(", ")}`);
    const journal = await postWdSent(tx, cur, actor);
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DALAM_PROSES", sentAt: cur.date, journalId: journal.id } });
    await tx.approvalLog.create({ data: { transactionId: id, action: "DALAM_PROSES", fromStatus: cur.status, toStatus: "DALAM_PROSES", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `${note ? `${note} · ` : ""}Jurnal ${journal.number}: penjualan diakui, dana dalam perjalanan` } });
    await audit({ actorId: actor.id, actorName: actor.name }, "WD_DALAM_PROSES", "FinanceTransaction", id, { journal: journal.number }, tx);
    return { transaction: t, journal };
  });
}

/**
 * Setujui transaksi dari web/bot: WD TikTok → Dalam Proses, lainnya langsung dibukukan seperti biasa.
 * Skrip perbaikan data tetap memakai approveAndBook langsung.
 */
export async function confirmTransaction(id: string, actor: Actor & { id: string }, note?: string) {
  const cur = await prisma.financeTransaction.findUniqueOrThrow({ where: { id } });
  if (await isTiktokWithdraw(cur)) {
    const r = await markInProcess(id, actor, note);
    // Screenshot "Detail penarikan dana" yang sudah "Berhasil ditransfer" = uang sudah masuk bank:
    // langsung dibukukan lengkap (jurnal 1 + jurnal 2), tanpa tombol "Uang diterima"
    const w = sellerOf(cur);
    if (w?.transferred && cur.proofPath) {
      const done = await receiveWithdraw(id, actor, { canApprove: true, proof: { path: cur.proofPath, mime: cur.proofMime ?? "image/jpeg", read: sellerProofRead(w) } });
      return { inProcess: false as const, transaction: done.transaction, journal: done.journal };
    }
    return { inProcess: true as const, ...r };
  }
  const r = await approveAndBook(id, actor, note);
  return { inProcess: false as const, ...r };
}

/** Hasil baca "Detail penarikan dana" Seller Center yang disimpan di transaksi (bot) */
export function sellerOf(t: { aiExtraction: unknown }): SellerWithdrawal | null {
  return ((t.aiExtraction as { seller?: SellerWithdrawal } | null)?.seller as SellerWithdrawal | undefined) ?? null;
}

/** Setting: 4 digit terakhir rekening tujuan WD TikTok (bawaan 5984 = Seabank operasional) */
export const WD_TIKTOK_BANK_SETTING = "wd_tiktok_rekening";

/** Rekening tujuan WD TikTok: SELALU Seabank 5984 (4 digit di nama/alias/kode rekening). Null bila belum ada. */
export async function tiktokDestination() {
  const last4 = (await prisma.setting.findUnique({ where: { key: WD_TIKTOK_BANK_SETTING } }))?.value?.trim() || "5984";
  const banks = await prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, orderBy: { code: "asc" } });
  return { last4, bank: banks.find((b) => `${b.name} ${b.aliases} ${b.code}`.includes(last4)) ?? null };
}

/**
 * WD Dalam Proses yang cocok dengan screenshot detail penarikan: No. Referensi sama, atau (tanpa referensi tercatat)
 * nominal sama + tanggal pengajuan = tanggal transfer tercatat.
 */
export async function findInProcessFor(w: SellerWithdrawal) {
  if (w.ref) {
    const byRef = await prisma.financeTransaction.findFirst({ where: { withdrawRef: w.ref, status: { notIn: ["DITOLAK", "DIBATALKAN"] }, deletedAt: null } });
    if (byRef) return byRef;
  }
  if (!w.amount || !w.submitted) return null;
  const rows = await prisma.financeTransaction.findMany({ where: { status: "DALAM_PROSES", deletedAt: null, amount: BigInt(w.amount), withdrawRef: null } });
  return rows.find((r) => (r.sentAt ?? r.date).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }) === w.submitted!.date) ?? null;
}

/** Yang boleh menekan "Uang diterima": penyetuju keuangan, atau pembuat transaksi itu sendiri */
export async function canReceive(id: string, user: { id: string; canApprove: boolean }) {
  if (user.canApprove) return true;
  return !!(await prisma.approvalLog.findFirst({ where: { transactionId: id, action: "DIBUAT", actorUserId: user.id } }));
}

export type WdProof = { path: string; mime: string; read: WdProofRead | null };

/**
 * Tanggal/jam terima dari bukti (wajib): nominal withdraw harus tertulis di bukti & tanggal terbaca. Bila bukti tidak
 * terbaca otomatis, hanya penyetuju (Owner/Finance) yang boleh menyimpan dengan tanda "sudah dicek manual".
 * Tanggal/jam yang terbaca di bukti dipakai sebagai waktu terima; isian manual hanya bila bukti tidak memuatnya.
 */
export function resolveReceivedAt(amount: number, proof: WdProof | null | undefined, opts: { receivedAt?: Date | null; manual?: boolean; canApprove: boolean }) {
  if (!proof?.path) throw new FinanceError("Wajib lampirkan screenshot bukti: uang masuk di aplikasi bank, atau Seller Center TikTok yang menunjukkan dana sudah ditransfer (ada tanggal & jam).");
  const check = checkWdProof(proof.read, amount);
  const manual = !check.ok && !!opts.manual;
  if (!check.ok && !manual) throw new FinanceError(`Bukti belum valid: ${check.issues.join("; ")}. Kirim screenshot yang menampilkan nominal, tanggal & jam${opts.canApprove ? ", atau tandai sudah dicek manual" : ""}.`);
  if (manual && !opts.canApprove) throw new FinanceError("Bukti tidak terbaca otomatis: hanya Owner/Finance yang dapat menyimpan dengan cek manual");
  const hm = opts.receivedAt && !isNaN(opts.receivedAt.getTime()) ? opts.receivedAt.toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }) : nowTimeStr();
  // Bukti Seller Center: tanggalnya = ditransfer; uang masuk bank 1–3 hari kemudian → waktu terima boleh diubah
  // (tidak sebelum tanggal transfer). Bukti mutasi bank: tanggal & jam di bukti = waktu terima.
  const seller = check.ok && proof.read?.source === "seller";
  const fromProof = proof.read?.date ? jakartaDateTime(proof.read.date, proof.read.time ?? hm) : null;
  const at = seller && opts.receivedAt && !isNaN(opts.receivedAt.getTime()) ? opts.receivedAt : (fromProof ?? opts.receivedAt ?? null);
  if (!at || isNaN(at.getTime())) throw new FinanceError("Tanggal/jam terima tidak valid");
  if (seller && fromProof && at.getTime() < fromProof.getTime()) throw new FinanceError(`Uang tidak mungkin diterima sebelum ditransfer (${fmtDateTime(fromProof)} di Seller Center)`);
  return { at, check, manual };
}

/**
 * "Uang diterima": WD Dalam Proses → jurnal 2 SEKALI, bertanggal/jam terima dari bukti (Dana dalam Perjalanan →
 * rekening tujuan) → DIBUKUKAN. Rekening tujuan boleh diganti (mis. ternyata masuk ke rekening lain).
 */
export async function receiveWithdraw(id: string, actor: Actor & { id: string }, opts: { receivedAt?: Date | null; toAccountId?: string | null; canApprove: boolean; proof: WdProof | null; manual?: boolean }, now: Date = new Date()) {
  if (!(await canReceive(id, { id: actor.id, canApprove: opts.canApprove }))) throw new FinanceError("Hanya Owner/Finance atau pembuat transaksi yang dapat menandai uang diterima");
  const amount = Number((await prisma.financeTransaction.findUniqueOrThrow({ where: { id }, select: { amount: true } })).amount);
  const { at: receivedAt, check, manual } = resolveReceivedAt(amount, opts.proof, opts);
  if (receivedAt.getTime() > now.getTime() + 5 * 60_000) throw new FinanceError("Tanggal/jam terima tidak boleh di masa depan");
  const proof = opts.proof!;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (cur.status === "DIBUKUKAN") throw new FinanceError(`${cur.number} sudah dibukukan (uang sudah diterima)`);
    if (cur.status !== "DALAM_PROSES") throw new FinanceError(`${cur.number} tidak berstatus Dalam Proses`);
    if (cur.withdrawRef && proof.read?.ref && proof.read.ref !== cur.withdrawRef) throw new FinanceError(`No. Referensi di bukti (${proof.read.ref}) berbeda dengan ${cur.number} (${cur.withdrawRef})`);
    const toAccountId = opts.toAccountId || cur.toAccountId;
    if (!toAccountId || toAccountId === cur.accountId) throw new FinanceError("Rekening tujuan tidak valid");
    const to = await tx.bankAccount.findUnique({ where: { id: toAccountId } });
    if (!to?.active || to.marketplace) throw new FinanceError("Rekening tujuan harus rekening bank/dompet aktif, bukan saldo penjual");
    const journal = await postWdReceived(tx, cur, toAccountId, receivedAt, actor);
    const read = { ...(proof.read ?? { amounts: [], amount: null, date: null, time: null }), manual };
    const t = await tx.financeTransaction.update({ where: { id }, data: { status: "DIBUKUKAN", receivedAt, toAccountId, withdrawRef: cur.withdrawRef ?? proof.read?.ref ?? null, receivedProofPath: proof.path, receivedProofMime: proof.mime, receivedProofRead: read } });
    const how = manual ? `bukti dicek manual oleh ${actor.name} (${check.issues.join("; ")})` : `bukti terbaca ${proof.read?.date ?? ""} ${proof.read?.time ?? ""}`.trim();
    await tx.approvalLog.create({ data: { transactionId: id, action: "UANG_DITERIMA", fromStatus: "DALAM_PROSES", toStatus: "DIBUKUKAN", actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId ?? null, note: `Uang diterima ${fmtDateTime(receivedAt)} di ${to.name} · ${how} · jurnal ${journal.number}`.slice(0, 300) } });
    await audit({ actorId: actor.id, actorName: actor.name }, "WD_UANG_DITERIMA", "FinanceTransaction", id, { journal: journal.number, receivedAt, proof: read }, tx);
    return { transaction: t, journal };
  });
}

export type InProcessRow = { id: string; number: string; amount: number; date: Date; sentAt: Date | null; from: string; to: string; toAccountId: string | null; store: string | null; note: string | null; createdById: string | null };

/** Semua WD yang masih Dalam Proses (terlama dulu) */
export async function inProcessWithdrawals(): Promise<InProcessRow[]> {
  const rows = await prisma.financeTransaction.findMany({ where: { status: "DALAM_PROSES", deletedAt: null }, orderBy: [{ date: "asc" }, { createdAt: "asc" }], include: { store: true, approvals: { where: { action: "DIBUAT" }, select: { actorUserId: true }, take: 1 } } });
  const banks = await prisma.bankAccount.findMany({ where: { id: { in: rows.flatMap((r) => [r.accountId, r.toAccountId]).filter((x): x is string => !!x) } } });
  const nm = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "—";
  return rows.map((r) => ({ id: r.id, number: r.number, amount: Number(r.amount), date: r.date, sentAt: r.sentAt, from: nm(r.accountId), to: nm(r.toAccountId), toAccountId: r.toAccountId, store: r.store?.code ?? null, note: r.note, createdById: r.approvals[0]?.actorUserId ?? null }));
}

export function inProcessSummary(rows: Pick<InProcessRow, "amount">[]) {
  return { count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) };
}

/** Pesan pengingat bot (null = tidak ada WD dalam proses, tidak perlu dikirim) */
export function inProcessReminderText(rows: InProcessRow[], esc: (s: string) => string) {
  if (!rows.length) return null;
  const { total } = inProcessSummary(rows);
  return [
    `⏳ <b>${rows.length} withdraw TikTok dalam proses</b> (total ${idr(total)})`,
    "Penjualannya sudah tercatat, tetapi uangnya belum masuk rekening bank (saldo bank ERP belum bertambah).",
    "",
    ...rows.map((r, k) => `${k + 1}. <b>${esc(r.number)}</b> ${r.store ? `${esc(r.store)} ` : ""}${idr(r.amount)} → ${esc(r.to)} · ditransfer ${fmtDateTime(r.sentAt ?? r.date)}`),
    "",
    "Tekan <b>💰 Uang diterima</b> bila uangnya sudah masuk.",
  ].join("\n");
}
