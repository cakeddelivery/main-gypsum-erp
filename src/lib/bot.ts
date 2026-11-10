import { prisma } from "./db";
import { effectivePermissions } from "./rbac";
import { DEFAULT_MANAGER_NAMES, detectManagerLoan, extractDate, extractTransaction, hasExplicitAmount, matchStore, mergeReceipt } from "./extract";
import { readReceipt, type ReceiptRead } from "./receipt";
import { ocrReceipt } from "./ocrReceipt";
import { type SplitInput, splitIssues, createTransaction, FinanceError, rejectTransaction, STATUS_LABEL, submitForConfirmation, updateTransaction, missingFields } from "./finance";
import { answerCallback, chatAction, downloadTelegramFile, editTelegram, esc, sendTelegram, type InlineButton } from "./telegram";
import { saveProof } from "./storage";
import { idr } from "./money";
import { addDays, fmtDate, fmtDateTime, jakartaDateTime, todayStr, txTime } from "./time";
import { dailyRecapText } from "./jobs";
import { handleMenuCallback, handleMenuCommand, MENU_TEXT } from "./botMenu";
import { clearSession, getSession, handleFlowCallback, handleFlowLocation, handleFlowText, retryRows, startPrefilledFlow, type TgLocation } from "./botFlow";
import { detectPurchase, extractSplits, rawMaterials } from "./botPurchase";
import { prefilledPayablePayment, prefilledPurchase, prefilledReserve, prefilledTalangan, talanganPhoto } from "./botFlow3";
import { talanganSummary } from "./talangan";
import { salePaymentPhoto } from "./botSales";
import { detectPayablePayment } from "./botPurchase";
import { openPayables } from "./payables";
import { matchReserveTransfer } from "./reserve";
import { supplierKey, supplierNames } from "./suppliers";
import { cbId, chunk, createDraft, dateUnconfirmed, draftMessage, resolveCategory, type DraftInput, type Pick } from "./botDraft";
export { draftMessage } from "./botDraft";
import { appUrl, guardDup } from "./botDup";
import { approveCategoryProposal, canApproveCategory, proposeCategory, rejectCategoryProposal, suggestCategories, type CatSuggestion } from "./categorySuggest";
import type { Session } from "./botKit";
import { confirmTransaction, isTiktokWithdraw } from "./wdProcess";
import { wdCallback } from "./botWd";
import { balanceCheckCallback, balanceCheckMessageHook } from "./balanceCheck";

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
    document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
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

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(msg)), ms)))]).finally(() => clearTimeout(timer));
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
  // Cek saldo pagi "Tidak sesuai": saldo bank yang diketik + lampiran mutasi (foto/PDF)
  if (await balanceCheckMessageHook(ident, chatId, msg)) return;
  // Isian bertahap (produksi, absen, stok): lokasi & jawaban teks
  if (msg.location) {
    await handleFlowLocation(ident, chatId, msg.location, { forwarded: !!(msg.forward_origin || msg.forward_date), venue: !!msg.venue, ageSec: msg.date ? Math.floor(Date.now() / 1000) - msg.date : 0 });
    return;
  }
  // Isian pengembalian dana talangan menunggu foto bukti transfer
  if (msg.photo?.length) {
    const s = await getSession(chatId);
    if (s?.flow === "tlg" && s.step === "proof" && s.userId === ident.userId) {
      const photo = await downloadTelegramFile(msg.photo[msg.photo.length - 1].file_id);
      if (!photo) {
        await sendTelegram(chatId, "Foto gagal diunduh, coba kirim ulang.");
        return;
      }
      await chatAction(chatId, "typing").catch(() => {});
      return startPrefilledFlow({ i: ident, chatId }, await talanganPhoto({ i: ident, chatId }, s, photo, String(msg.message_id)));
    }
    // Isian cicilan piutang penjualan menunggu foto bukti (opsional)
    if (s?.flow === "jcil" && s.step === "proof" && s.userId === ident.userId) {
      const photo = await downloadTelegramFile(msg.photo[msg.photo.length - 1].file_id);
      if (!photo) {
        await sendTelegram(chatId, "Foto gagal diunduh, coba kirim ulang.");
        return;
      }
      return startPrefilledFlow({ i: ident, chatId }, await salePaymentPhoto(s, photo));
    }
  }
  if (text === MENU_TEXT || (text.startsWith("/") && text !== "/batal")) await clearSession(chatId);
  else if (text && !msg.photo && (await handleFlowText(ident, chatId, text))) return;
  if (await handleMenuCommand(ident, chatId, text)) return;
  if (text === "/rekap") {
    // Rekap berisi saldo rekening & arus kas: sama dengan tombol menu, hanya untuk yang boleh melihat ringkasan keuangan
    if (!ident.perms.has("dashboard.finance")) {
      await sendTelegram(chatId, "Anda tidak berwenang melihat rekap keuangan.");
      return;
    }
    await sendTelegram(chatId, await dailyRecapText(new Date()), { type: "REKAP_MANUAL" });
    return;
  }
  if (text === "/bantuan" || text === "/help") {
    await sendTelegram(chatId, "Kirim pesan atau foto bukti transaksi, contoh:\n<i>bayar listrik 350rb dari seabank hari ini</i>\n<i>terima pencairan shopee 1,2jt ke saldo penjual</i>\n<i>transfer internal dari saldo penjual ke seabank 500rb</i>\n\nAtau kirim <b>foto bukti transfer/nota</b> dengan caption keterangan saja, misal <i>beli cat supplier A</i>. Nominal, tanggal & rekening dibaca dari foto.\n\nSaya akan membuat DRAFT dan meminta konfirmasi.\n\n/menu untuk menu tombol (ringkasan & unduh laporan JPG), /rekap untuk rekap harian.");
    return;
  }
  // Pesan/foto bebas menjadi draft transaksi: wajib izin kirim di Telegram DAN izin input transaksi di perannya
  if (!ident.canSubmit || !ident.perms.has("finance.create")) {
    await sendTelegram(chatId, "Anda tidak memiliki izin mengirim transaksi. Gunakan /menu untuk fitur yang tersedia.");
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
  // Rincian per baris ("dus bekas 5k / galon 20k / ongkir 10k"): nominal total diambil dari bukti transfer
  const materials = await rawMaterials();
  let splits = extractSplits(text, cats, materials, ex.direction);
  if (photo && (splits.length || !hasExplicitAmount(text) || !ex.direction || !ex.accountId)) {
    await chatAction(chatId, "typing").catch(() => {});
    // Batasi waktu baca AI agar balasan tidak tertahan (Nginx/Telegram memutus permintaan yang terlalu lama)
    receipt = await withTimeout(readReceipt(photo, text, banks), 35_000, "AI membaca foto terlalu lama").catch((e) => {
      console.error("readReceipt:", e instanceof Error ? e.message : e);
      return null;
    });
    // AI tidak terpasang / kuota habis / tidak menemukan nominal → baca foto dengan OCR di server
    if (!receipt?.amount || !receipt.direction || !receipt.account) {
      const ocr = await withTimeout(ocrReceipt(photo, banks), 20_000, "OCR terlalu lama").catch((e) => {
        console.error("ocrReceipt:", e instanceof Error ? e.message : e);
        return null;
      });
      if (ocr) receipt = receipt ? { ...ocr, ...Object.fromEntries(Object.entries(receipt).filter(([, v]) => v != null)) } : ocr;
    }
  }
  ex = mergeReceipt(ex, text, receipt, banks, cats);
  if (splits.length) {
    splits = extractSplits(text, cats, materials, ex.direction ?? "KELUAR");
    if (splits.length) {
      ex.direction = ex.direction ?? "KELUAR";
      ex.amount = receipt?.amount ?? splits.reduce((t, x) => t + x.amount, 0);
    }
  }
  // Pinjaman pengelola ("Edy pinjam dana OPS untuk pribadi"): Piutang Pengelola, bukan bayar hutang/pinjaman.
  // Pengembalian oleh pengelola = uang masuk berkategori Pengembalian Pinjaman Pengelola
  const loan = splits.length ? null : detectManagerLoan(text, await managerNames());
  if (loan) {
    const cat = cats.find((c) => c.name === (loan === "PINJAM" ? "Pinjaman Pengelola" : "Pengembalian Pinjaman Pengelola"));
    if (cat) {
      ex.direction = cat.direction;
      ex.categoryId = cat.id;
      ex.toAccountId = null;
    }
  }
  if (!ex.amount || !ex.direction) {
    await sendTelegram(chatId, `Saya belum bisa membaca ${!ex.amount ? "nominal" : "jenis transaksi (masuk/keluar/transfer)"} dari ${photo ? "foto & keterangan" : "pesan"} ini. Tulis ulang dengan lebih lengkap, misal: <i>bayar gypsum 2jt dari seabank</i>.`);
    return;
  }
  // Withdraw saldo penjual: toko dibedakan dari inisial MG / DL (atau nama toko); bila tidak ada, ditanyakan
  const seller = ex.direction === "TRANSFER" ? banks.find((b) => b.id === ex.accountId && b.marketplace) : null;
  const stores = seller ? await prisma.store.findMany({ where: { active: true } }) : [];
  const storeId = seller ? matchStore([text, receipt?.counterparty].filter(Boolean).join(" "), stores) : null;
  // Kategori belum dikenali: saran 1–3 kategori (kata kunci → riwayat → AI bila ada) atau usulan kategori baru
  const catSuggest = ex.direction !== "TRANSFER" && !ex.categoryId && !splits.length ? await suggestCategories(prisma, { direction: ex.direction, text: [text, receipt?.counterparty].filter(Boolean).join(" ") }, { ai: true }).catch(() => null) : null;
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
    // WD saldo penjual tanpa tanggal di keterangan maupun bukti (bukti WD TikTok tidak mencantumkan tanggal):
    // tanggal wajib dipastikan sebelum dibukukan
    aiExtraction: { ...ex, ...(receipt ? { receipt } : {}), ...(catSuggest && (catSuggest.picks.length || catSuggest.proposal) ? { catSuggest } : {}), ...(seller && !extractDate(text) && !receipt?.date ? { needDate: true } : {}) },
    messageId: String(msg.message_id),
    storeId,
    askStore: !!seller && !storeId,
    splits: splits.length ? splits.map((x) => ({ categoryId: x.itemId ? null : x.categoryId, amount: x.amount, note: x.label, itemId: x.itemId, qty: x.qty })) : undefined,
  };
  const ctx = { i: ident, chatId };
  const basis = [text, receipt?.counterparty].filter(Boolean).join(" ");
  // Transfer ke rekening simpanan sebesar talangan yang belum dikembalikan (atau berketerangan "talangan") = pengembalian talangan
  if (!loan && !splits.length && ex.direction === "TRANSFER" && ex.toAccountId && ident.perms.has("finance.approve")) {
    const w = (await talanganSummary()).find((x) => x.bank.id === ex.toAccountId && x.outstanding > 0);
    if (w && (ex.amount === w.outstanding || /\btalangan\b/i.test(basis))) {
      const session = await prefilledTalangan(ctx, { walletId: w.bank.id, proofPath, read: ex.amount, messageId: String(msg.message_id), date: ex.date });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Bukti transfer dana sisihan (nominal = kelipatan sisihan harian, rekening sesuai alur dana)
  if (!loan && !splits.length && (ex.direction === "TRANSFER" || ex.direction === "KELUAR") && ident.perms.has("finance.approve")) {
    const m = await matchReserveTransfer({ amount: ex.amount, fromBankId: ex.accountId, toBankId: ex.direction === "TRANSFER" ? ex.toAccountId : null, date: ex.date!, text: basis });
    if (m) {
      const session = await prefilledReserve(ctx, { options: m.options, sure: m.sure, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Angsuran hutang supplier / cicilan pinjaman ("angsur kardus", "bayar hutang <nama>", nominal = cicilan): langsung ke isian bayar hutang
  if (!loan && !splits.length && ex.direction === "KELUAR" && (ident.perms.has("accounting.post") || ident.perms.has("finance.approve"))) {
    const hit = detectPayablePayment(basis, await openPayables(), ex.direction, ex.amount);
    if (hit) {
      const session = await prefilledPayablePayment(ctx, { candidates: hit.matches.map((p) => p.id), amount: ex.amount, bankId: ex.accountId, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Pembelian bahan baku sesuai master data: langsung ke isian Pembelian (stok + hutang/kas), bukan draft biasa
  if (!loan && !splits.length && ex.direction === "KELUAR" && ident.perms.has("finance.approve")) {
    const hit = detectPurchase([text, receipt?.counterparty].filter(Boolean).join(" "), materials, ex.direction);
    if (hit) {
      const supplier = await matchSupplier([text, receipt?.counterparty].filter(Boolean).join(" "));
      const session = await prefilledPurchase(
        { i: ident, chatId },
        { item: hit.item, others: hit.others.map((o) => ({ id: o.id, name: o.name })), qty: hit.qty, amount: ex.amount, bankId: ex.accountId, supplier, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft },
      );
      if (session) return startPrefilledFlow({ i: ident, chatId }, session);
    }
  }
  await startDraft(ctx, draft);
}

/**
 * Catat draft transaksi biasa. Bila ada transaksi mirip (nominal & tanggal sama, termasuk dari menu lain), bot
 * bertanya dulu lewat isian "trx" (kartu konfirmasi) dan tidak langsung menyimpan.
 */
async function startDraft(ctx: { i: NonNullable<Awaited<ReturnType<typeof identityOf>>>; chatId: string }, draft: DraftInput) {
  const s: Session = { chatId: ctx.chatId, userId: ctx.i.userId, flow: "trx", step: "confirm", data: { tx: JSON.stringify(draft) } };
  const q = { direction: draft.direction, amount: draft.amount, date: new Date(draft.date), accountId: draft.accountId, toAccountId: draft.toAccountId, categoryId: draft.categoryId, text: [draft.note, draft.rawText].filter(Boolean).join(" ") };
  if (await guardDup(s, "ok", q)) return startPrefilledFlow(ctx, s);
  await createDraft(ctx.chatId, ctx.i, draft);
}

/** Panggilan pengelola untuk mengenali pinjaman pengelola: bawaan + setting pengelola_nama (dipisah koma) */
async function managerNames() {
  const s = await prisma.setting.findUnique({ where: { key: "pengelola_nama" } });
  return [...DEFAULT_MANAGER_NAMES, ...(s?.value ?? "").split(",")].map((x) => x.trim()).filter(Boolean);
}

/** Supplier yang namanya disebut di caption atau nama penerima di bukti transfer */
async function matchSupplier(text: string) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const sups = await prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true, aliases: true } });
  // Nama atau nama lain supplier (setelah digabung), tanpa kata umum "supplier"/"toko"
  const hit = sups
    .map((x) => ({ x, len: Math.max(0, ...supplierNames(x).map(supplierKey).filter((n) => n.length >= 4 && t.includes(` ${n} `)).map((n) => n.length)) }))
    .filter((r) => r.len > 0)
    .sort((a, b) => b.len - a.len)[0];
  return hit ? { id: hit.x.id, name: hit.x.name } : null;
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
      return startDraft({ i: ident, chatId }, JSON.parse(String(s.data.tx)) as DraftInput);
    }
    try {
      return await handleFlowCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
    } catch (e) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "ISIAN", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (e as Error).message.slice(0, 500) } });
      // Jangan hanya notifikasi kecil: kirim pesan dengan tombol ulang/batal, isian tetap tersimpan
      await sendTelegram(chatId, `⚠️ Terjadi kesalahan saat memproses tombol (${esc((e as Error).message.slice(0, 120))}).\nIsian Anda masih tersimpan.`, { buttons: retryRows }).catch(() => {});
      return answerCallback(cb.id, "Terjadi kesalahan");
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
  if (["acc", "to", "cat", "st", "dt", "no", "chg", "sc", "sa", "sx"].includes(action) && !ident.canSubmit && !canReview) return answerCallback(cb.id, "Anda tidak berwenang mengubah transaksi");
  // Tombol ganti (🏦 / 🏷️ / 🏪) / ◀ Kembali: hanya mengganti tampilan pilihan, belum mengubah data
  if (action === "kn" || action === "ka" || action === "kr") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    try {
      return await categoryCallback(ident, cb.id, chatId, cb.message.message_id, action, txId);
    } catch (e) {
      return answerCallback(cb.id, e instanceof FinanceError ? e.message : "Terjadi kesalahan");
    }
  }
  if (action === "wr" || action === "wp" || action === "wd" || action === "wl") {
    // Withdraw TikTok Dalam Proses: uang diterima (konfirmasi tanggal terima)
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    return wdCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
  }
  if (action === "cs") {
    // Konfirmasi saldo pagi
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    return balanceCheckCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
  }
  if (action === "dv") {
    // Lihat transaksi lama yang mirip, lalu kembali ke kartu draft
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    const t = await prisma.financeTransaction.findUnique({ where: { id: txId } });
    if (!t?.duplicateOfId) return answerCallback(cb.id, "Tidak ada transaksi mirip");
    const old = await draftMessage(t.duplicateOfId);
    await editTelegram(chatId, cb.message.message_id, `🔎 <b>Transaksi lama</b>\n\n${old.text}\n${appUrl()}/finance/${t.duplicateOfId}`, [[{ text: "◀ Kembali ke draft", callback_data: `back:${txId}` }]]);
    return answerCallback(cb.id, "");
  }
  if (action === "chg" || action === "back") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    const m = await draftMessage(txId, action === "chg" && (["acc", "to", "cat", "st", "dt"].includes(value) || /^s\d+$/.test(value)) ? (value as Pick) : undefined);
    const r = await editTelegram(chatId, cb.message.message_id, m.text, m.buttons);
    if (!r.ok) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "WEBHOOK", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (r.error ?? "").slice(0, 500) } });
      return answerCallback(cb.id, "Gagal menampilkan pilihan, coba lagi");
    }
    return answerCallback(cb.id, "");
  }
  let okInProcess = false;
  if (action === "no" && !canReview) {
    const own = await prisma.approvalLog.findFirst({ where: { transactionId: txId, action: "DIBUAT", actorUserId: ident.userId } });
    if (!own) return answerCallback(cb.id, "Hanya pembuat draft atau peninjau keuangan yang dapat menolak");
  }
  try {
    if (action === "acc") await updateTransaction(txId, { accountId: value }, actor);
    else if (action === "to") await updateTransaction(txId, { toAccountId: value }, actor);
    else if (action === "cat") {
      const catId = await resolveCategory(value);
      if (!catId) return answerCallback(cb.id, "Kategori tidak ditemukan, coba lagi");
      await updateTransaction(txId, { categoryId: catId }, actor);
    }
    else if (action === "st") await updateTransaction(txId, { storeId: value }, actor);
    else if (action === "dt") {
      // Tanggal baru, jam tetap; tanda "tanggal sudah dipastikan" disimpan di data ekstraksi
      if (!/^\d{8}$/.test(value ?? "")) return answerCallback(cb.id, "Tanggal tidak valid");
      const cur = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      const hm = cur.date.toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false });
      await updateTransaction(txId, { date: jakartaDateTime(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, hm) }, actor);
      await prisma.financeTransaction.update({ where: { id: txId }, data: { aiExtraction: { ...((cur.aiExtraction as object | null) ?? {}), dateOk: true } } });
    }
    else if (action === "sc" || action === "sa" || action === "sx") {
      const cur = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId }, include: { splits: { orderBy: { sortOrder: "asc" } } } });
      const rows = cur.splits.map((x) => ({ categoryId: x.categoryId, amount: Number(x.amount), note: x.note, itemId: x.itemId, qty: x.qty ? Number(x.qty) : null }));
      if (action === "sc") {
        const k = Number(value);
        const catId = await resolveCategory((cb.data ?? "").split(":")[3]);
        if (!rows[k] || !catId) return answerCallback(cb.id, "Rincian tidak ditemukan");
        rows[k] = { ...rows[k], categoryId: catId, itemId: null, qty: null };
        await updateTransaction(txId, { splits: rows, categoryId: null }, actor);
      } else if (action === "sa") await updateTransaction(txId, { amount: rows.reduce((a, x) => a + x.amount, 0) }, actor);
      else await updateTransaction(txId, { splits: [] }, actor);
    }
    else if (action === "rev") {
      // "Berbeda, tetap simpan": peninjau keuangan, atau pembuat draft sendiri (tidak lagi buntu hanya bisa Tolak)
      if (!canReview && !(await prisma.approvalLog.findFirst({ where: { transactionId: txId, action: "DIBUAT", actorUserId: ident.userId } }))) return answerCallback(cb.id, "Hanya pembuat draft atau peninjau keuangan");
      await prisma.$transaction(async (tx) => {
        const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
        if (cur.status !== "PERLU_DITINJAU") throw new FinanceError("Transaksi tidak dalam status Perlu Ditinjau");
        // Diingat agar tidak ditandai mirip lagi saat rekening/kategori/tanggal diganti
        await tx.financeTransaction.update({ where: { id: txId }, data: { duplicateOfId: null, dupAckIds: cur.duplicateOfId ? [...new Set([...cur.dupAckIds, cur.duplicateOfId])] : cur.dupAckIds } });
        await tx.approvalLog.create({ data: { transactionId: txId, action: "BUKAN_DUPLIKAT", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId, note: "Ditandai bukan duplikat via Telegram" } });
      });
    } else if (action === "no") {
      await rejectTransaction(txId, actor, "Ditolak via Telegram");
    } else if (action === "ok") {
      // Konfirmasi wajib dari identitas Telegram terpetakan yang memiliki izin
      if (!ident.canConfirm || !ident.perms.has("finance.approve")) return answerCallback(cb.id, "Anda tidak berwenang mengonfirmasi pembukuan");
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      if (dateUnconfirmed(t) && !(await isTiktokWithdraw(t))) return answerCallback(cb.id, "Pilih tanggal dana masuk dulu");
      if (t.status === "PERLU_DITINJAU" || t.status === "DRAFT") await submitForConfirmation(txId, actor, "Dikonfirmasi via Telegram");
      okInProcess = (await confirmTransaction(txId, actor, "Dikonfirmasi via Telegram")).inProcess;
    } else return answerCallback(cb.id, "Aksi tidak dikenal");
    // Setelah data dilengkapi, kembalikan ke Menunggu Konfirmasi bila sudah lengkap
    if (["acc", "to", "cat", "st", "dt", "rev", "sc", "sa", "sx"].includes(action)) {
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      const sp = await prisma.financeTxSplit.findMany({ where: { transactionId: txId } });
      if (t.status === "PERLU_DITINJAU" && !t.duplicateOfId && missingFields(t).length === 0 && splitIssues(t.amount, t.direction, sp).length === 0) await submitForConfirmation(txId, actor, "Dilengkapi via Telegram");
    }
    const m = await draftMessage(txId);
    if (chatId && cb.message) await editTelegram(chatId, cb.message.message_id, m.text, m.buttons);
    return answerCallback(cb.id, action === "ok" ? (okInProcess ? "Dalam proses ⏳ — tekan Uang diterima saat uang masuk" : "Dibukukan ✅") : action === "no" ? "Ditolak (dibuang)" : "Tersimpan");
  } catch (e) {
    return answerCallback(cb.id, e instanceof FinanceError ? e.message : "Terjadi kesalahan");
  }
}

type Ident = NonNullable<Awaited<ReturnType<typeof identityOf>>>;

/**
 * Kategori baru dari bot. kn:<transaksi> = usulkan (pengguna yang boleh mengirim transaksi), ka/kr:<usulan> =
 * setujui/tolak (HANYA Owner/Finance). Persetujuan membuat akun COA (kode otomatis) + kategori, lalu draftnya
 * langsung memakai kategori itu.
 */
async function categoryCallback(ident: Ident, cbId: string, chatId: string, messageId: number, action: string, id: string) {
  const actor = { id: ident.userId, name: ident.user.name, role: ident.user.role };
  if (action === "kn") {
    if (!ident.canSubmit && !ident.perms.has("finance.review") && !ident.perms.has("finance.approve")) return answerCallback(cbId, "Anda tidak berwenang");
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id } });
    const p = (t.aiExtraction as { catSuggest?: CatSuggestion } | null)?.catSuggest?.proposal;
    if (!p) return answerCallback(cbId, "Tidak ada usulan kategori untuk transaksi ini");
    const prop = await proposeCategory(p, { transactionId: t.id, chatId }, actor);
    const text = proposalText(prop);
    if (canApproveCategory(ident.user.role)) {
      await sendTelegram(chatId, text, { buttons: proposalButtons(prop.id), type: "KATEGORI" });
      return answerCallback(cbId, "");
    }
    // Pengguna biasa: usulan diteruskan ke Owner/Finance
    const approvers = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: { in: ["OWNER", "FINANCE"] } } } });
    for (const a of approvers) await sendTelegram(a.chatId!, `${text}\nDiusulkan oleh ${esc(ident.user.name)}.`, { buttons: proposalButtons(prop.id), type: "KATEGORI" }).catch(() => {});
    await sendTelegram(chatId, `📨 Usulan kategori <b>${esc(prop.name)}</b> dikirim ke Owner/Finance. Draft tetap tersimpan; kategori bisa dipilih dari daftar sambil menunggu.`);
    return answerCallback(cbId, "Usulan dikirim");
  }
  if (!canApproveCategory(ident.user.role)) return answerCallback(cbId, "Hanya Owner/Finance yang dapat menyetujui kategori baru");
  if (action === "kr") {
    const r = await rejectCategoryProposal(id, actor);
    await editTelegram(chatId, messageId, `❌ Usulan kategori <b>${esc(r.name)}</b> ditolak oleh ${esc(actor.name)}.`, []);
    return answerCallback(cbId, "Ditolak");
  }
  const r = await approveCategoryProposal(id, actor);
  await editTelegram(chatId, messageId, `✅ Kategori <b>${esc(r.proposal.name)}</b> dibuat${r.coaCode ? ` (akun ${r.coaCode})` : " (sudah ada, dipakai)"} oleh ${esc(actor.name)}.`, []);
  // Draft yang memicu usulan langsung memakai kategori baru, lalu kartu draftnya dikirim ulang ke pengusul
  const t = r.proposal.transactionId ? await prisma.financeTransaction.findUnique({ where: { id: r.proposal.transactionId } }) : null;
  if (t && ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status) && !t.categoryId && t.direction === r.proposal.direction) {
    await updateTransaction(t.id, { categoryId: r.categoryId }, { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId });
    const u = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    const sp = await prisma.financeTxSplit.findMany({ where: { transactionId: t.id } });
    if (u.status === "PERLU_DITINJAU" && !u.duplicateOfId && missingFields(u).length === 0 && splitIssues(u.amount, u.direction, sp).length === 0) await submitForConfirmation(t.id, { id: ident.userId, name: ident.user.name }, "Kategori baru disetujui");
    const m = await draftMessage(t.id);
    await sendTelegram(r.proposal.chatId ?? chatId, `🏷️ Kategori <b>${esc(r.proposal.name)}</b> disetujui dan dipakai.\n\n${m.text}`, { buttons: m.buttons, type: "DRAFT" });
  }
  return answerCallback(cbId, "Disetujui ✅");
}

function proposalText(p: { name: string; direction: string; coaType: string; parentCoaId: string | null }) {
  return `🏷️ <b>Usulan kategori baru</b>\nNama: <b>${esc(p.name)}</b>\nJenis: ${p.direction === "MASUK" ? "Pemasukan" : "Pengeluaran"} · akun ${p.coaType === "PENDAPATAN" ? "Pendapatan" : p.coaType === "HPP" ? "HPP" : "Beban"} (kode dibuat otomatis)\n\nSetujui? Hanya Owner/Finance.`;
}

function proposalButtons(id: string): InlineButton[][] {
  return [[{ text: "✅ Setujui & buat", callback_data: `ka:${id}` }, { text: "❌ Tolak", callback_data: `kr:${id}` }]];
}
