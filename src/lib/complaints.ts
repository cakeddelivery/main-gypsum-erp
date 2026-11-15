import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { locationSettings, recordMovement, reverseMovementsByRef, StockError } from "./stock";
import { recipeMaterialCost } from "./hpp";
import type { Permission } from "./rbac";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string; role?: string };

/** Sumber jurnal komplain: refund dibayar (baris tertaut Transaksi) & barang pengganti */
export const COMPLAINT_SOURCE = "KOMPLAIN";
export const COA_REFUND = "4-1200";
export const COA_GARANSI = "6-1820";
export const REFUND_CATEGORY = "Retur & Refund Penjualan";

export { ISSUE_TYPES, issueLabel, SOLUTIONS, solutionLabel, COMPLAINT_STATUS, complaintStatusOf } from "./complaintShared";
import { COMPLAINT_STATUS, ISSUE_TYPES, SOLUTIONS, issueLabel } from "./complaintShared";

/** Rekening refund pembeli hanya untuk pengaju, penyetuju/pembayar refund (Finance) dan Owner */
export function canSeePayee(c: { createdById: string | null }, user: { id: string; role: string; can: (p: Permission) => boolean }) {
  return user.role === "OWNER" || c.createdById === user.id || user.can("refund.approve") || user.can("refund.pay");
}

export type ComplaintLineInput = { labelSku?: string | null; labelName?: string | null; itemId?: string | null; qty: number; sendQty?: number };
export type ComplaintInput = {
  date: Date;
  marketplace?: string | null;
  courier?: string | null;
  trackingNo?: string | null;
  orderNo?: string | null;
  city?: string | null;
  province?: string | null;
  issueType: string;
  description?: string | null;
  solution: string;
  bundleNext?: boolean;
  refundAmount?: number;
  payeeBank?: string | null;
  payeeAccount?: string | null;
  payeeName?: string | null;
  labelRead?: Prisma.InputJsonValue | null;
  /// Ongkir kirim ganti / lain yang ditanggung toko (opsional, untuk analitik)
  shippingCost?: number;
  lines: ComplaintLineInput[];
};

const clean = (s: string | null | undefined, max = 120) => s?.trim().replace(/\s+/g, " ").slice(0, max) || null;

/** Validasi isian komplain (murni, dipakai juga unit test) */
export function validateComplaint(input: ComplaintInput) {
  if (!ISSUE_TYPES.some((i) => i.key === input.issueType)) throw new StockError("Pilih jenis masalah");
  if (!SOLUTIONS.some((s) => s.key === input.solution)) throw new StockError("Pilih solusi: refund atau kirim ganti");
  if (!clean(input.trackingNo) && !clean(input.orderNo)) throw new StockError("Isi no. resi atau no. pesanan");
  const lines = input.lines.filter((l) => (l.itemId || l.labelSku?.trim() || l.labelName?.trim()) && l.qty > 0).map((l) => ({ ...l, qty: Math.round(l.qty), sendQty: Math.round(l.sendQty ?? 0) }));
  if (!lines.length) throw new StockError("Isi minimal satu barang yang bermasalah");
  if (input.solution === "REFUND") {
    const amount = Math.round(input.refundAmount ?? 0);
    if (!(amount > 0)) throw new StockError("Isi nominal refund");
    if (!clean(input.payeeBank) || !clean(input.payeeAccount) || !clean(input.payeeName)) throw new StockError("Isi rekening/e-wallet pembeli: nama bank/e-wallet, nomor, dan atas nama");
    if (!/^[0-9 .-]{5,30}$/.test(input.payeeAccount!.trim())) throw new StockError("Nomor rekening/e-wallet hanya angka");
  } else {
    if (!lines.some((l) => l.itemId && l.sendQty > 0)) throw new StockError("Kirim ganti: pilih produk ERP dan jumlah pengganti");
    if (lines.some((l) => l.sendQty < 0)) throw new StockError("Jumlah pengganti tidak boleh minus");
  }
  return lines;
}

export async function createComplaint(input: ComplaintInput, actor: Actor) {
  const lines = validateComplaint(input);
  const refund = input.solution === "REFUND";
  return prisma.$transaction(async (tx) => {
    const ids = [...new Set(lines.map((l) => l.itemId).filter(Boolean) as string[])];
    const items = await tx.item.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, name: true } });
    for (const id of ids) if (items.find((i) => i.id === id)?.type !== "BARANG_JADI") throw new StockError("Barang harus produk jadi");
    const number = await nextNumber(tx, "KMP", input.date);
    const c = await tx.complaint.create({
      data: {
        number, date: input.date, marketplace: clean(input.marketplace, 20), courier: clean(input.courier, 30), trackingNo: clean(input.trackingNo, 40)?.toUpperCase().replace(/\s+/g, "") ?? null,
        orderNo: clean(input.orderNo, 40)?.toUpperCase() ?? null, city: clean(input.city, 60), province: clean(input.province, 60), issueType: input.issueType, description: clean(input.description, 1000),
        solution: input.solution, bundleNext: !refund && !!input.bundleNext, refundAmount: BigInt(refund ? Math.round(input.refundAmount ?? 0) : 0),
        payeeBank: refund ? clean(input.payeeBank, 40) : null, payeeAccount: refund ? input.payeeAccount!.replace(/[^0-9]/g, "") : null, payeeName: refund ? clean(input.payeeName, 80) : null,
        labelRead: input.labelRead ?? undefined, createdBy: actor.name, createdById: actor.id, shippingCost: BigInt(Math.max(0, Math.round(input.shippingCost ?? 0))),
        lines: { create: lines.map((l, i) => ({ labelSku: clean(l.labelSku, 40)?.toUpperCase() ?? null, labelName: clean(l.labelName, 80), itemId: l.itemId || null, qty: l.qty, sendQty: refund ? 0 : l.sendQty, sortOrder: i })) },
      },
    });
    // Data rekening tidak ikut dicatat di log audit
    await audit(actor, "KOMPLAIN_DIBUAT", "Complaint", c.id, { number, solution: c.solution, amount: Number(c.refundAmount) }, tx);
    return c;
  });
}

async function lockOpen(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Complaint" WHERE id = ${id} FOR UPDATE`;
  const c = await tx.complaint.findUniqueOrThrow({ where: { id } });
  if (c.cancelledAt) throw new StockError(`${c.number} sudah dibatalkan`);
  return c;
}

/**
 * Setujui refund: cukup oleh Finance (izin refund.approve) berapa pun nominalnya. Owner boleh ikut menyetujui bila punya izin.
 */
export async function approveRefund(id: string, actor: Actor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    if (c.solution !== "REFUND") throw new StockError("Hanya refund yang perlu persetujuan");
    if (c.status !== "DIAJUKAN") throw new StockError(`${c.number} sudah ${COMPLAINT_STATUS[c.status].label.toLowerCase()}`);
    const out = await tx.complaint.update({ where: { id }, data: { status: "DISETUJUI", approvedBy: actor.name, approvedAt: now } });
    await audit(actor, "REFUND_DISETUJUI", "Complaint", id, { number: c.number }, tx);
    return out;
  });
}

export async function rejectComplaint(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan penolakan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    if (!["DIAJUKAN", "DISETUJUI"].includes(c.status)) throw new StockError(`${c.number} tidak bisa ditolak lagi`);
    const out = await tx.complaint.update({ where: { id }, data: { status: "DITOLAK", rejectedBy: actor.name, rejectedAt: now, rejectReason: reason.trim().slice(0, 300) } });
    await audit(actor, "KOMPLAIN_DITOLAK", "Complaint", id, { number: c.number, reason }, tx);
    return out;
  });
}

/**
 * Bayar refund: Dr Retur & Refund Penjualan (4-1200) / Cr rekening sumber. Jurnal sumber KOMPLAIN otomatis tampil
 * sebagai baris tertaut (pengeluaran kategori Retur & Refund Penjualan, dengan bukti) di menu Transaksi.
 */
export async function payRefund(id: string, p: { bankAccountId: string; date: Date; proofPath: string; proofMime: string }, actor: Actor) {
  if (!p.bankAccountId) throw new StockError("Pilih rekening sumber");
  if (!p.proofPath) throw new StockError("Unggah bukti transfer refund");
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    if (c.status !== "DISETUJUI") throw new StockError(`${c.number} belum disetujui / sudah dibayar`);
    await assertPeriodOpen(tx, p.date);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: p.bankAccountId } });
    const amount = Number(c.refundAmount);
    const j = await postJournal(tx, {
      date: p.date, description: `Refund komplain ${c.number}${c.orderNo ? ` pesanan ${c.orderNo}` : ""}`.slice(0, 150), source: COMPLAINT_SOURCE, sourceId: `${c.number}:REFUND`, actor,
      lines: [{ accountCode: COA_REFUND, debit: amount, memo: issueLabel(c.issueType) }, { accountId: bank.coaAccountId, credit: amount, memo: "Refund pembeli" }],
    });
    const cat = await tx.txCategory.findFirst({ where: { name: REFUND_CATEGORY, direction: "KELUAR" } });
    await tx.financeTransaction.updateMany({ where: { journalId: j.id, origin: COMPLAINT_SOURCE }, data: { ...(cat ? { categoryId: cat.id } : {}), proofPath: p.proofPath, proofMime: p.proofMime, counterparty: c.marketplace ?? "Pembeli" } });
    const out = await tx.complaint.update({ where: { id }, data: { status: "DIBAYAR", paidBy: actor.name, paidAt: p.date, payBankAccountId: bank.id, payJournalId: j.id, proofPath: p.proofPath, proofMime: p.proofMime } });
    await audit(actor, "REFUND_DIBAYAR", "Complaint", id, { number: c.number, amount, bank: bank.name }, tx);
    return out;
  });
}

/**
 * Kirim barang pengganti: stok barang jadi keluar, Dr Beban Garansi & Penggantian Barang (6-1820) / Cr Persediaan Barang Jadi.
 * Bukan HPP penjualan (tidak ada pendapatannya), jadi tidak dobel dengan opname akhir bulan.
 */
export async function sendReplacement(id: string, actor: Actor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    if (c.solution !== "KIRIM_GANTI") throw new StockError("Bukan komplain kirim ganti");
    if (c.status !== "DIAJUKAN") throw new StockError(`${c.number} sudah ${COMPLAINT_STATUS[c.status].label.toLowerCase()}`);
    await assertPeriodOpen(tx, now);
    const { finished } = await locationSettings(tx);
    if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
    const lines = await tx.complaintLine.findMany({ where: { complaintId: id, itemId: { not: null }, sendQty: { gt: 0 } }, include: { item: true } });
    if (!lines.length) throw new StockError("Tidak ada barang pengganti");
    const ref = `${c.number}-KIRIM`;
    let value = 0;
    for (const l of lines) {
      const fallback = Number(l.item!.avgCost) > 0 ? null : { value: await recipeMaterialCost(l.itemId!), note: "harga pokok dari resep" };
      const mv = await recordMovement(tx, { type: "PENGELUARAN", itemId: l.itemId!, qty: l.sendQty, fromLocationId: finished, ref, note: `Pengganti komplain ${c.number}`, date: now, allowNegative: true, noJournal: true, fallbackUnitCost: fallback }, actor);
      const unit = Number(mv.unitCost);
      value += Math.round(unit * l.sendQty);
      await tx.complaintLine.update({ where: { id: l.id }, data: { unitCost: BigInt(unit) } });
    }
    let journalId: string | null = null;
    if (value > 0) {
      const jl: LineInput[] = [{ accountCode: COA_GARANSI, debit: value, memo: issueLabel(c.issueType) }, { accountCode: COA.PERSEDIAAN_JADI, credit: value, memo: "Barang pengganti" }];
      journalId = (await postJournal(tx, { date: now, description: `Barang pengganti komplain ${c.number}`, source: COMPLAINT_SOURCE, sourceId: `${c.number}:KIRIM`, actor, lines: jl })).id;
    }
    const out = await tx.complaint.update({ where: { id }, data: { status: "DIKIRIM", sentBy: actor.name, sentAt: now, sendJournalId: journalId, sendRef: ref, replacementValue: BigInt(value) } });
    await audit(actor, "KOMPLAIN_PENGGANTI_DIKIRIM", "Complaint", id, { number: c.number, value }, tx);
    return out;
  });
}

export async function finishComplaint(id: string, actor: Actor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    if (c.status !== "DIBAYAR" && c.status !== "DIKIRIM") throw new StockError(c.solution === "REFUND" ? "Refund belum dibayar" : "Barang pengganti belum dikirim");
    const out = await tx.complaint.update({ where: { id }, data: { status: "SELESAI", doneAt: now, doneBy: actor.name } });
    await audit(actor, "KOMPLAIN_SELESAI", "Complaint", id, { number: c.number }, tx);
    return out;
  });
}

const reverseDate = (tx: Tx, date: Date, now: Date) => assertPeriodOpen(tx, date).then(() => date, () => now);

/** Batalkan komplain salah input: refund dibayar / pengganti dikirim dibalik (jurnal balik, stok kembali) */
export async function cancelComplaint(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const c = await lockOpen(tx, id);
    const why = `Batal komplain ${c.number} — ${reason.trim()}`.slice(0, 150);
    if (c.payJournalId) await reverseJournal(tx, c.payJournalId, await reverseDate(tx, c.paidAt ?? now, now), actor, why);
    if (c.sendJournalId) await reverseJournal(tx, c.sendJournalId, await reverseDate(tx, c.sentAt ?? now, now), actor, why);
    if (c.sendRef) await reverseMovementsByRef(tx, c.sendRef, `BATAL ${c.sendRef}`, why, actor);
    const out = await tx.complaint.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await audit(actor, "KOMPLAIN_DIBATALKAN", "Complaint", id, { number: c.number, reason }, tx);
    return out;
  });
}

/** Kirim bukti bayar refund ke Telegram pengaju (untuk diteruskan ke pembeli). Tidak menggagalkan pembayaran bila bot mati. */
export async function sendRefundProof(id: string, readFile: (rel: string) => Promise<Buffer>) {
  const { sendTelegram, sendTelegramDocument, telegramConfigured, esc } = await import("./telegram");
  const c = await prisma.complaint.findUniqueOrThrow({ where: { id } });
  if (!c.createdById || !c.proofPath || !telegramConfigured()) return { sent: false, reason: "bot/penerima tidak ada" };
  const who = await prisma.telegramIdentity.findFirst({ where: { userId: c.createdById, active: true, chatId: { not: null } } });
  if (!who?.chatId) return { sent: false, reason: "akun pengaju belum tertaut Telegram" };
  const caption = `✅ Refund ${c.number} sudah dibayar: Rp ${Number(c.refundAmount).toLocaleString("id-ID")}${c.orderNo ? `\nPesanan ${c.orderNo}` : ""}\nTeruskan bukti ini ke pembeli.`;
  const buf = await readFile(c.proofPath);
  const ext = c.proofMime === "application/pdf" ? "pdf" : "jpg";
  const r = await sendTelegramDocument(who.chatId, buf, `bukti-refund-${c.number}.${ext}`, caption, { type: "REFUND_BUKTI" }).catch(() => ({ ok: false }));
  if (!r.ok) await sendTelegram(who.chatId, esc(caption), { type: "REFUND_BUKTI" }).catch(() => null);
  if (r.ok) await prisma.complaint.update({ where: { id }, data: { proofSentAt: new Date() } });
  return { sent: r.ok };
}
