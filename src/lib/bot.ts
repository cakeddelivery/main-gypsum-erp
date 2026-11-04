import { prisma } from "./db";
import { effectivePermissions } from "./rbac";
import { extractTransaction, hasExplicitAmount, mergeReceipt } from "./extract";
import { readReceipt, type ReceiptRead } from "./receipt";
import { ocrReceipt } from "./ocrReceipt";
import { approveAndBook, createTransaction, FinanceError, rejectTransaction, STATUS_LABEL, submitForConfirmation, updateTransaction, missingFields } from "./finance";
import { answerCallback, chatAction, downloadTelegramFile, editTelegram, esc, sendTelegram, type InlineButton } from "./telegram";
import { saveProof } from "./storage";
import { idr } from "./money";
import { fmtDate, jakartaDateTime, txTime } from "./time";
import { dailyRecapText } from "./jobs";
import { handleMenuCallback, handleMenuCommand, MENU_TEXT } from "./botMenu";
import { clearSession, getSession, handleFlowCallback, handleFlowLocation, handleFlowText, startPrefilledFlow, type TgLocation } from "./botFlow";
import { detectPurchase, rawMaterials } from "./botPurchase";
import { prefilledPayablePayment, prefilledPurchase, prefilledReserve } from "./botFlow3";
import { detectPayablePayment } from "./botPurchase";
import { openPayables } from "./payables";
import { matchReserveTransfer } from "./reserve";

type TgUser = { id: number; first_name?: string; username?: string };
type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    chat: { id: number };
    from?: TgUser;
    text?: string;
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    location?: TgLocation;
    venue?: unknown;
    forward_origin?: unknown;
    forward_date?: number;
  };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
};

async function identityOf(tgId: number) {
  const ident = await prisma.telegramIdentity.findUnique({ where: { telegramUserId: String(tgId) }, include: { user: true } });
  if (!ident || !ident.active || !ident.user.active) return null;
  const overrides = await prisma.rolePermission.findMany({ where: { role: ident.user.role } });
  const perms = effectivePermissions(ident.user.role, overrides);
  return { ...ident, perms };
}

/** Ringkasan draft + tombol interaktif sesuai data yang masih kurang */
export async function draftMessage(txId: string): Promise<{ text: string; buttons: InlineButton[][] }> {
  const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
  const [banks, cats] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ where: { active: true, direction: t.direction }, orderBy: { name: "asc" } }),
  ]);
  const bank = banks.find((b) => b.id === t.accountId);
  const to = banks.find((b) => b.id === t.toAccountId);
  const cat = cats.find((c) => c.id === t.categoryId);
  const dir = t.direction === "MASUK" ? "Pemasukan" : t.direction === "KELUAR" ? "Pengeluaran" : "Transfer internal";
  const lines = [
    `<b>${esc(t.number)}</b> · ${STATUS_LABEL[t.status]}`,
    `Jenis: ${dir}`,
    `Nominal: <b>${idr(t.amount)}</b>`,
    `Tanggal: ${fmtDate(t.date)}`,
    `Rekening: ${bank ? esc(bank.name) : "—"}${t.direction === "TRANSFER" ? ` → ${to ? esc(to.name) : "—"}` : ""}`,
    t.direction !== "TRANSFER" ? `Kategori: ${cat ? esc(cat.name) : "—"}` : "",
    t.note ? `Catatan: ${esc(t.note.slice(0, 200))}` : "",
    t.duplicateOfId ? "⚠️ Terindikasi duplikat dengan transaksi lain." : "",
  ].filter(Boolean);
  const buttons: InlineButton[][] = [];
  if (t.status === "DIBUKUKAN" || t.status === "DITOLAK" || t.status === "DIBATALKAN") return { text: lines.join("\n"), buttons };
  if (!t.accountId) {
    lines.push("\nPilih rekening:");
    buttons.push(...chunk(banks.map((b) => ({ text: b.name, callback_data: `acc:${t.id}:${b.id}` })), 2));
  } else if (t.direction === "TRANSFER" && !t.toAccountId) {
    lines.push("\nPilih rekening tujuan:");
    buttons.push(...chunk(banks.filter((b) => b.id !== t.accountId).map((b) => ({ text: b.name, callback_data: `to:${t.id}:${b.id}` })), 2));
  } else if (t.direction !== "TRANSFER" && !t.categoryId) {
    lines.push("\nPilih kategori:");
    buttons.push(...chunk(cats.slice(0, 12).map((c) => ({ text: c.name, callback_data: `cat:${t.id}:${c.id}` })), 2));
  } else if (t.status === "PERLU_DITINJAU" && t.duplicateOfId) {
    buttons.push([{ text: "Bukan duplikat, lanjutkan", callback_data: `rev:${t.id}` }]);
  }
  buttons.push([
    ...(missingFields(t).length === 0 && !t.duplicateOfId ? [{ text: "✅ Konfirmasi", callback_data: `ok:${t.id}` }] : []),
    { text: "❌ Batalkan", callback_data: `no:${t.id}` },
  ]);
  return { text: lines.join("\n"), buttons };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Proses update dari Telegram Bot API (webhook). Tidak pernah membukukan tanpa tombol konfirmasi manusia berwenang. */
export async function handleTelegramUpdate(u: TgUpdate) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg?.from) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? msg.caption ?? "").trim();
  const ident = await identityOf(msg.from.id);

  if (text === "/start" || text === "/id") {
    await sendTelegram(chatId, `Halo! ID Telegram Anda: <code>${msg.from.id}</code>\n${ident ? `Terhubung sebagai <b>${esc(ident.user.name)}</b>.` : "Belum terdaftar. Minta Owner menautkan ID ini di menu Pengaturan → Telegram & Hermes."}`);
    if (ident && !ident.chatId) await prisma.telegramIdentity.update({ where: { id: ident.id }, data: { chatId } });
    if (ident && text === "/start") await handleMenuCommand(ident, chatId, "/menu");
    return;
  }
  if (!ident) {
    await sendTelegram(chatId, "Akun Telegram Anda belum diizinkan. Kirim /id lalu minta Owner mendaftarkan ID Anda.");
    return;
  }
  if (!ident.chatId) await prisma.telegramIdentity.update({ where: { id: ident.id }, data: { chatId } });
  // Isian bertahap (produksi, absen, stok): lokasi & jawaban teks
  if (msg.location) {
    await handleFlowLocation(ident, chatId, msg.location, { forwarded: !!(msg.forward_origin || msg.forward_date), venue: !!msg.venue, ageSec: msg.date ? Math.floor(Date.now() / 1000) - msg.date : 0 });
    return;
  }
  if (text === MENU_TEXT || (text.startsWith("/") && text !== "/batal")) await clearSession(chatId);
  else if (text && !msg.photo && (await handleFlowText(ident, chatId, text))) return;
  if (await handleMenuCommand(ident, chatId, text)) return;
  if (text === "/rekap") {
    await sendTelegram(chatId, await dailyRecapText(new Date()), { type: "REKAP_MANUAL" });
    return;
  }
  if (text === "/bantuan" || text === "/help") {
    await sendTelegram(chatId, "Kirim pesan atau foto bukti transaksi, contoh:\n<i>bayar listrik 350rb dari seabank hari ini</i>\n<i>terima pencairan shopee 1,2jt ke saldo penjual</i>\n<i>transfer internal dari saldo penjual ke seabank 500rb</i>\n\nAtau kirim <b>foto bukti transfer/nota</b> dengan caption keterangan saja, misal <i>beli cat supplier A</i>. Nominal, tanggal & rekening dibaca dari foto.\n\nSaya akan membuat DRAFT dan meminta konfirmasi.\n\n/menu untuk menu tombol (ringkasan & unduh laporan JPG), /rekap untuk rekap harian.");
    return;
  }
  if (!ident.canSubmit) {
    await sendTelegram(chatId, "Anda tidak memiliki izin mengirim transaksi.");
    return;
  }
  if (!text && !msg.photo) return;

  let proofPath: string | null = null;
  let photo: Buffer | null = null;
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    photo = await downloadTelegramFile(largest.file_id);
    if (photo) proofPath = await saveProof(photo, "image/jpeg").catch(() => null);
  }
  const [banks, cats] = await Promise.all([prisma.bankAccount.findMany({ where: { active: true } }), prisma.txCategory.findMany({ where: { active: true } })]);
  let ex = extractTransaction(text || "foto bukti", banks, cats);
  // Foto bukti + caption keterangan: nominal, tanggal & rekening dibaca dari foto
  let receipt: ReceiptRead | null = null;
  // Nominal dari caption hanya dipercaya bila ditulis jelas (Rp/rb/jt); angka lain bisa jumlah barang atau tahun
  if (photo && (!hasExplicitAmount(text) || !ex.direction || !ex.accountId)) {
    await chatAction(chatId, "typing").catch(() => {});
    receipt = await readReceipt(photo, text, banks).catch((e) => {
      console.error("readReceipt:", e instanceof Error ? e.message : e);
      return null;
    });
    // AI tidak terpasang / kuota habis / tidak menemukan nominal → baca foto dengan OCR di server
    if (!receipt?.amount || !receipt.direction || !receipt.account) {
      const ocr = await ocrReceipt(photo, banks).catch((e) => {
        console.error("ocrReceipt:", e instanceof Error ? e.message : e);
        return null;
      });
      if (ocr) receipt = receipt ? { ...ocr, ...Object.fromEntries(Object.entries(receipt).filter(([, v]) => v != null)) } : ocr;
    }
  }
  ex = mergeReceipt(ex, text, receipt, banks, cats);
  if (!ex.amount || !ex.direction) {
    await sendTelegram(chatId, `Saya belum bisa membaca ${!ex.amount ? "nominal" : "jenis transaksi (masuk/keluar/transfer)"} dari ${photo ? "foto & keterangan" : "pesan"} ini. Tulis ulang dengan lebih lengkap, misal: <i>bayar gypsum 2jt dari seabank</i>.`);
    return;
  }
  const draft: DraftInput = {
    direction: ex.direction,
    amount: ex.amount,
    date: jakartaDateTime(ex.date!, txTime(ex.date!, ex.time)).toISOString(),
    accountId: ex.accountId,
    toAccountId: ex.toAccountId,
    categoryId: ex.categoryId,
    note: (text ? ex.note : (receipt?.counterparty ?? "")).slice(0, 500) || null,
    rawText: text,
    proofPath,
    aiExtraction: receipt ? { ...ex, receipt } : ex,
    messageId: String(msg.message_id),
  };
  const ctx = { i: ident, chatId };
  const basis = [text, receipt?.counterparty].filter(Boolean).join(" ");
  // Bukti transfer dana sisihan (nominal = kelipatan sisihan harian, rekening sesuai alur dana)
  if ((ex.direction === "TRANSFER" || ex.direction === "KELUAR") && ident.perms.has("finance.approve")) {
    const m = await matchReserveTransfer({ amount: ex.amount, fromBankId: ex.accountId, toBankId: ex.direction === "TRANSFER" ? ex.toAccountId : null, date: ex.date!, text: basis });
    if (m) {
      const session = await prefilledReserve(ctx, { options: m.options, sure: m.sure, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Angsuran / pembayaran utang supplier ("angsur kardus"): langsung ke isian bayar utang
  if (ex.direction === "KELUAR" && (ident.perms.has("accounting.post") || ident.perms.has("finance.approve"))) {
    const hit = detectPayablePayment(basis, await openPayables(), ex.direction);
    if (hit) {
      const session = await prefilledPayablePayment(ctx, { candidates: hit.matches.map((p) => p.id), amount: ex.amount, bankId: ex.accountId, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Pembelian bahan baku sesuai master data: langsung ke isian Pembelian (stok + utang/kas), bukan draft biasa
  if (ex.direction === "KELUAR" && ident.perms.has("finance.approve")) {
    const hit = detectPurchase([text, receipt?.counterparty].filter(Boolean).join(" "), await rawMaterials(), ex.direction);
    if (hit) {
      const supplier = await matchSupplier([text, receipt?.counterparty].filter(Boolean).join(" "));
      const session = await prefilledPurchase(
        { i: ident, chatId },
        { item: hit.item, others: hit.others.map((o) => ({ id: o.id, name: o.name })), qty: hit.qty, amount: ex.amount, bankId: ex.accountId, supplier, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft },
      );
      if (session) return startPrefilledFlow({ i: ident, chatId }, session);
    }
  }
  await createDraft(chatId, ident, draft);
}

/** Data draft transaksi dari pesan bot (disimpan di sesi pembelian agar bisa dicatat sebagai transaksi biasa) */
type DraftInput = {
  direction: "MASUK" | "KELUAR" | "TRANSFER";
  amount: number;
  date: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  rawText: string;
  proofPath: string | null;
  aiExtraction: unknown;
  messageId: string;
};

async function createDraft(chatId: string, ident: NonNullable<Awaited<ReturnType<typeof identityOf>>>, d: DraftInput) {
  const { transaction } = await createTransaction(
    {
      direction: d.direction,
      amount: d.amount,
      date: new Date(d.date),
      accountId: d.accountId,
      toAccountId: d.toAccountId,
      categoryId: d.categoryId,
      suggestedCategoryId: d.categoryId,
      note: d.note,
      rawText: d.rawText,
      proofPath: d.proofPath,
      proofMime: d.proofPath ? "image/jpeg" : null,
      aiExtraction: d.aiExtraction as object,
      idempotencyKey: `tg:${chatId}:${d.messageId}`,
      telegramChatId: chatId,
      telegramMessageId: d.messageId,
    },
    "TELEGRAM",
    { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId },
  );
  const m = await draftMessage(transaction.id);
  await sendTelegram(chatId, `📝 Draft dibuat (belum dibukukan)\n\n${m.text}`, { buttons: m.buttons, type: "DRAFT" });
}

/** Supplier yang namanya disebut di caption atau nama penerima di bukti transfer */
async function matchSupplier(text: string) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const sups = await prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true } });
  return sups.filter((x) => { const n = x.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return n.length >= 3 && t.includes(` ${n} `); }).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>) {
  const [action, txId, value] = (cb.data ?? "").split(":");
  const chatId = cb.message ? String(cb.message.chat.id) : null;
  const ident = await identityOf(cb.from.id);
  if (!ident) return answerCallback(cb.id, "ID Telegram Anda belum terdaftar");
  if (action === "f") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia, kirim /menu");
    if (cb.data === "f:plain") {
      // Isian pembelian dari pesan → dibatalkan, pesan dicatat sebagai draft transaksi biasa
      const s = await getSession(chatId);
      if (!s?.data.tx || s.userId !== ident.userId) return answerCallback(cb.id, "Isian sudah kedaluwarsa, kirim ulang pesannya");
      await clearSession(chatId);
      await answerCallback(cb.id, "");
      await editTelegram(chatId, cb.message.message_id, "Dicatat sebagai transaksi biasa.", []).catch(() => {});
      return createDraft(chatId, ident, JSON.parse(String(s.data.tx)) as DraftInput);
    }
    try {
      return await handleFlowCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
    } catch (e) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "ISIAN", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (e as Error).message.slice(0, 500) } });
      return answerCallback(cb.id, "Terjadi kesalahan, coba lagi");
    }
  }
  if (action === "m") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan menu sudah tidak tersedia, kirim /menu");
    try {
      return await handleMenuCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
    } catch (e) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "MENU", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (e as Error).message.slice(0, 500) } });
      return answerCallback(cb.id, "Terjadi kesalahan, coba lagi");
    }
  }
  const actor = { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId };
  // Melengkapi/membatalkan draft: hanya identitas yang boleh mengirim transaksi atau peninjau/penyetuju keuangan
  const canReview = ident.perms.has("finance.review") || ident.perms.has("finance.approve");
  if (["acc", "to", "cat", "no"].includes(action) && !ident.canSubmit && !canReview) return answerCallback(cb.id, "Anda tidak berwenang mengubah transaksi");
  if (action === "no" && !canReview) {
    const own = await prisma.approvalLog.findFirst({ where: { transactionId: txId, action: "DIBUAT", actorUserId: ident.userId } });
    if (!own) return answerCallback(cb.id, "Hanya pembuat draft atau peninjau keuangan yang dapat membatalkan");
  }
  try {
    if (action === "acc") await updateTransaction(txId, { accountId: value }, actor);
    else if (action === "to") await updateTransaction(txId, { toAccountId: value }, actor);
    else if (action === "cat") await updateTransaction(txId, { categoryId: value }, actor);
    else if (action === "rev") {
      if (!ident.perms.has("finance.review")) return answerCallback(cb.id, "Anda tidak berwenang meninjau");
      await prisma.$transaction(async (tx) => {
        const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
        if (cur.status !== "PERLU_DITINJAU") throw new FinanceError("Transaksi tidak dalam status Perlu Ditinjau");
        await tx.financeTransaction.update({ where: { id: txId }, data: { duplicateOfId: null } });
        await tx.approvalLog.create({ data: { transactionId: txId, action: "BUKAN_DUPLIKAT", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId, note: "Ditandai bukan duplikat via Telegram" } });
      });
    } else if (action === "no") {
      await rejectTransaction(txId, actor, "Dibatalkan via Telegram");
    } else if (action === "ok") {
      // Konfirmasi wajib dari identitas Telegram terpetakan yang memiliki izin
      if (!ident.canConfirm || !ident.perms.has("finance.approve")) return answerCallback(cb.id, "Anda tidak berwenang mengonfirmasi pembukuan");
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      if (t.status === "PERLU_DITINJAU" || t.status === "DRAFT") await submitForConfirmation(txId, actor, "Dikonfirmasi via Telegram");
      await approveAndBook(txId, actor, "Dikonfirmasi via Telegram");
    } else return answerCallback(cb.id, "Aksi tidak dikenal");
    // Setelah data dilengkapi, kembalikan ke Menunggu Konfirmasi bila sudah lengkap
    if (["acc", "to", "cat", "rev"].includes(action)) {
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      if (t.status === "PERLU_DITINJAU" && !t.duplicateOfId && missingFields(t).length === 0) await submitForConfirmation(txId, actor, "Dilengkapi via Telegram");
    }
    const m = await draftMessage(txId);
    if (chatId && cb.message) await editTelegram(chatId, cb.message.message_id, m.text, m.buttons);
    return answerCallback(cb.id, action === "ok" ? "Dibukukan ✅" : action === "no" ? "Dibatalkan" : "Tersimpan");
  } catch (e) {
    return answerCallback(cb.id, e instanceof FinanceError ? e.message : "Terjadi kesalahan");
  }
}
