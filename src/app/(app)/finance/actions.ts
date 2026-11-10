"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { attachTransactionProof, linkBookedTransfer, setReserveLink, changeBookedStore, reclassifyBooked, cancelBookedTransaction, deleteClosedTransactions, restoreClosedTransactions, createTransaction, rejectTransaction, submitForConfirmation, updateTransaction, type TxInput } from "@/lib/finance";
import { saveProof } from "@/lib/storage";
import { confirmTransaction, receiveWithdraw } from "@/lib/wdProcess";
import { readWdProofFile } from "@/lib/wdProofServer";
import { reserveOptions } from "@/lib/reserveSync";
import { todayStr } from "@/lib/time";
import { extractTransaction } from "@/lib/extract";
import { detectPayablePayment } from "@/lib/botPurchase";
import { openPayables } from "@/lib/payables";
import { fmtDateTime, jakartaDateTime, txTime } from "@/lib/time";
import { assertPerm } from "@/lib/auth";
import type { TxDirection } from "@prisma/client";

async function readForm(fd: FormData): Promise<TxInput> {
  const direction = z.enum(["MASUK", "KELUAR", "TRANSFER"]).parse(str(fd, "direction")) as TxDirection;
  const date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal wajib diisi");
  const time = txTime(date, str(fd, "time"));
  let proofPath: string | null = null;
  let proofMime: string | null = null;
  const file = fd.get("proof");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    proofMime = file.type;
    proofPath = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
  }
  return {
    direction,
    amount: int(fd, "amount"),
    date: jakartaDateTime(date, time),
    accountId: optStr(fd, "accountId"),
    toAccountId: optStr(fd, "toAccountId"),
    categoryId: optStr(fd, "categoryId"),
    suggestedCategoryId: optStr(fd, "suggestedCategoryId"),
    storeId: optStr(fd, "storeId"),
    counterparty: optStr(fd, "counterparty"),
    note: optStr(fd, "note"),
    rawText: optStr(fd, "rawText"),
    proofPath,
    proofMime,
    splits: readSplits(fd),
    payableId: direction === "KELUAR" ? optStr(fd, "payableId") : null,
    payInterest: direction === "KELUAR" && str(fd, "payInterest") ? int(fd, "payInterest") : null,
  };
}

/** Rincian dari form (undefined = form tanpa bagian rincian, rincian lama tidak diubah) */
function readSplits(fd: FormData): TxInput["splits"] {
  if (!fd.get("splitsOn")) return undefined;
  const all = (k: string) => fd.getAll(k).map(String);
  const notes = all("splitNote");
  const cats = all("splitCat");
  const amounts = all("splitAmount");
  const items = all("splitItem");
  const qtys = all("splitQty");
  return notes
    .map((note, i) => ({ note: note.trim() || null, categoryId: cats[i] || null, amount: Number((amounts[i] ?? "").replace(/\D/g, "")) || 0, itemId: items[i] || null, qty: qtys[i] ? Number(qtys[i]) : null }))
    .filter((x) => x.amount > 0);
}

export const createTx = action(
  "finance.create",
  async (fd, user) => {
    const input = await readForm(fd);
    const submit = str(fd, "intent") === "submit";
    const { transaction, duplicate } = await createTransaction({ ...input, idempotencyKey: optStr(fd, "formKey") ? `web:${user.id}:${str(fd, "formKey")}` : null }, "MANUAL", { id: user.id, name: user.name }, { submit });
    redirect(`/finance/${transaction.id}${duplicate ? "?dup=1" : ""}`);
  },
  ["/finance", "/"],
);

export const updateTx = action(
  "finance.create",
  async (fd, user) => {
    const input = await readForm(fd);
    await updateTransaction(str(fd, "id"), { ...input, proofPath: input.proofPath ?? undefined, proofMime: input.proofMime ?? undefined }, { id: user.id, name: user.name });
    return "Perubahan tersimpan";
  },
  ["/finance"],
);

export const submitTx = action(["finance.create", "finance.review"], async (fd, user) => {
  await submitForConfirmation(str(fd, "id"), { id: user.id, name: user.name }, optStr(fd, "note") ?? undefined);
  return "Diajukan untuk konfirmasi";
}, ["/finance", "/"]);

export const approveTx = action("finance.approve", async (fd, user) => {
  const r = await confirmTransaction(str(fd, "id"), { id: user.id, name: user.name }, optStr(fd, "note") ?? undefined);
  return r.inProcess ? "Dikonfirmasi: withdraw TikTok Dalam Proses. Tekan \"Uang diterima\" setelah uangnya masuk rekening." : `Disetujui & dibukukan (${r.journal.number})`;
}, ["/finance", "/", "/akuntansi"]);

/**
 * WD TikTok Dalam Proses: uang sudah masuk rekening → dibukukan dengan tanggal/jam dari bukti. Bukti (screenshot
 * uang masuk / Seller Center "ditransfer") wajib; nominal & tanggalnya dibaca OCR (browser, dicek ulang di server).
 */
export const receiveWdTx = action(["finance.create", "finance.approve"], async (fd, user) => {
  const id = str(fd, "id");
  const file = fd.get("proof");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) throw new Error("Wajib lampirkan screenshot bukti uang masuk / Seller Center TikTok (ada tanggal & jam)");
  const buf = Buffer.from(await file.arrayBuffer());
  const path = await saveProof(buf, file.type);
  const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id }, select: { amount: true } });
  const read = await readWdProofFile(buf, file.type, Number(t.amount), optStr(fd, "ocrText"));
  const date = str(fd, "date");
  const time = /^\d{2}:\d{2}$/.test(str(fd, "time")) ? str(fd, "time") : "12:00";
  const manual = fd.get("manual") === "on" && user.can("finance.approve");
  const { journal, transaction } = await receiveWithdraw(id, { id: user.id, name: user.name }, { receivedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? jakartaDateTime(date, time) : null, toAccountId: optStr(fd, "toAccountId"), canApprove: user.can("finance.approve"), proof: { path, mime: file.type, read }, manual });
  return `Uang diterima ${fmtDateTime(transaction.receivedAt)}, dibukukan (${journal.number})`;
}, ["/finance", "/", "/akuntansi"]);

export const rejectTx = action(["finance.review", "finance.approve"], async (fd, user) => {
  await rejectTransaction(str(fd, "id"), { id: user.id, name: user.name }, str(fd, "reason"));
  return "Transaksi ditolak";
}, ["/finance", "/"]);

export const cancelTx = action("finance.approve", async (fd, user) => {
  const { reversal } = await cancelBookedTransaction(str(fd, "id"), { id: user.id, name: user.name }, str(fd, "reason"));
  return `Transaksi dibatalkan (jurnal pembalik ${reversal.number})`;
}, ["/finance", "/", "/akuntansi"]);

export const changeStoreTx = action("finance.approve", async (fd, user) => {
  await changeBookedStore(str(fd, "id"), str(fd, "storeId"), { id: user.id, name: user.name });
  return "Toko diganti";
}, ["/finance", "/", "/akuntansi"]);

/** Ubah kategori transaksi dibukukan, atau jadikan pembayaran hutang / cicilan pinjaman */
export const reclassifyTx = action("finance.approve", async (fd, user) => {
  const [kind, target] = str(fd, "target").split(":");
  if (!target) throw new Error("Pilih kategori atau hutang");
  const interest = str(fd, "interest") ? int(fd, "interest") : null;
  await reclassifyBooked(str(fd, "id"), kind === "pay" ? { payableId: target, interest } : { categoryId: target }, { id: user.id, name: user.name });
  return "Pencatatan diubah";
}, ["/finance", "/", "/akuntansi"]);

/** Pindah rekening transaksi dibukukan (salah pilih rekening) */
export const changeAccountTx = action("finance.approve", async (fd, user) => {
  await reclassifyBooked(str(fd, "id"), { accountId: str(fd, "accountId") }, { id: user.id, name: user.name });
  return "Rekening diganti";
}, ["/finance", "/", "/akuntansi"]);

export const deleteTx = action("finance.approve", async (fd, user) => {
  const ids = fd.getAll("id").map(String).filter(Boolean);
  const n = await deleteClosedTransactions(ids, { id: user.id, name: user.name });
  if (str(fd, "back")) redirect("/finance");
  return `${n} transaksi dihapus dari daftar`;
}, ["/finance", "/"]);

/** Tampilkan lagi transaksi yang disembunyikan (satu, atau semua yang disembunyikan pada status tertentu) */
export const restoreTx = action("finance.approve", async (fd, user) => {
  const status = str(fd, "status");
  const ids = status
    ? (await prisma.financeTransaction.findMany({ where: { status: z.enum(["DIBATALKAN", "DITOLAK"]).parse(status), deletedAt: { not: null } }, select: { id: true } })).map((r) => r.id)
    : fd.getAll("id").map(String).filter(Boolean);
  if (!ids.length) return "Tidak ada transaksi yang disembunyikan";
  const n = await restoreClosedTransactions(ids, { id: user.id, name: user.name });
  return `${n} transaksi ditampilkan lagi di daftar`;
}, ["/finance", "/"]);

/** Hapus semua transaksi berstatus tertentu (Dibatalkan/Ditolak) sekaligus */
export const deleteAllClosedTx = action("finance.approve", async (fd, user) => {
  const status = z.enum(["DIBATALKAN", "DITOLAK"]).parse(str(fd, "status"));
  const rows = await prisma.financeTransaction.findMany({ where: { status, deletedAt: null }, select: { id: true } });
  if (!rows.length) return "Tidak ada transaksi untuk dihapus";
  const n = await deleteClosedTransactions(rows.map((r) => r.id), { id: user.id, name: user.name });
  return `${n} transaksi dihapus dari daftar`;
}, ["/finance", "/"]);

/** Ekstraksi teks (fallback aturan) untuk membantu pengisian form */
export async function extractAction(text: string) {
  await assertPerm("finance.create");
  const [banks, cats] = await Promise.all([prisma.bankAccount.findMany({ where: { active: true } }), prisma.txCategory.findMany({ where: { active: true } })]);
  const ex = extractTransaction(text, banks, cats);
  // "angsur kardus", "bayar hutang afdhol": langsung dipasangkan ke hutang supplier / pinjaman yang belum lunas
  const hit = ex.direction === "KELUAR" ? detectPayablePayment(text, await openPayables(), ex.direction, ex.amount) : null;
  if (hit?.matches.length === 1) {
    ex.payableId = hit.matches[0].id;
    ex.missing = ex.missing.filter((m) => m !== "kategori");
  }
  return ex;
}

/** Pilihan dana sisihan untuk transfer (dihitung ulang di server dari rekening & nominal transaksi) */
async function reserveChoice(id: string, pick: string, toAccountId?: string | null) {
  const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id } });
  const m = await reserveOptions(prisma, { amount: Number(t.amount), fromBankId: t.accountId, toBankId: toAccountId ?? t.toAccountId, date: todayStr(t.date), text: [t.note, t.rawText, t.counterparty].filter(Boolean).join(" "), excludeTxId: t.id });
  const o = m?.options[Number(pick)];
  if (!o) throw new Error("Pilihan dana sisihan sudah tidak berlaku, muat ulang halaman");
  return o.parts;
}

/** Transfer belum dibukukan: pilih dana sisihan, transfer biasa, atau otomatis */
export const setReserveTx = action("finance.create", async (fd, user) => {
  const id = str(fd, "id");
  const pick = str(fd, "pick");
  await setReserveLink(id, pick === "auto" ? null : pick === "skip" ? { skip: true } : { parts: await reserveChoice(id, pick) }, { id: user.id, name: user.name });
  return pick === "skip" ? "Dicatat sebagai transfer biasa" : pick === "auto" ? "Dana sisihan dicocokkan otomatis saat dibukukan" : "Dana sisihan dipilih";
}, ["/finance"]);

/** Transfer yang sudah dibukukan dihubungkan ke dana sisihan (data lama) */
export const linkReserveTx = action("finance.approve", async (fd, user) => {
  const id = str(fd, "id");
  const toAccountId = optStr(fd, "toAccountId");
  const r = await linkBookedTransfer(id, { parts: await reserveChoice(id, str(fd, "pick"), toAccountId), toAccountId }, { id: user.id, name: user.name });
  return `Tersinkron ke dana sisihan (${r.created + r.absorbed} sisihan, bukti ikut terlampir)`;
}, ["/finance", "/finance/sisihan", "/", "/akuntansi"]);

/** Lampirkan / ganti bukti transaksi (juga yang sudah dibukukan); ikut ke sisihan yang tersambung */
export const attachProofTx = action("finance.create", async (fd, user) => {
  const file = fd.get("proof");
  if (!(file && typeof file === "object" && "arrayBuffer" in file && file.size > 0)) throw new Error("Pilih foto bukti");
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new Error("Bukti harus JPG, PNG, WEBP, atau PDF");
  const path = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
  const n = await attachTransactionProof(str(fd, "id"), { path, mime: file.type }, { id: user.id, name: user.name });
  return n ? `Bukti dilampirkan (juga ke ${n} sisihan)` : "Bukti dilampirkan";
}, ["/finance", "/finance/sisihan"]);
