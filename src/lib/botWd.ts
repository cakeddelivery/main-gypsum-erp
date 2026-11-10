import { prisma } from "./db";
import { FinanceError, submitForConfirmation } from "./finance";
import { answerCallback, chatAction, downloadTelegramFile, editTelegram, esc, sendTelegram, type InlineButton } from "./telegram";
import { clearSession, getSession } from "./botFlow";
import { saveProof } from "./storage";
import { checkWdProof, sellerProofRead, SELLER_NOTE, type SellerWithdrawal, type WdProofRead } from "./wdProof";
import { readWdProofFile } from "./wdProofServer";
import { addDays, fmtDate, fmtDateTime, jakartaDateTime, nowTimeStr, todayStr } from "./time";
import { idr } from "./money";
import { draftMessage, chunk, createDraft, type DraftInput } from "./botDraft";
import { matchStore } from "./extract";
import { STATUS_LABEL } from "./finance";
import { findInProcessFor, isTiktokSeller, tiktokDestination, canReceive, inProcessReminderText, inProcessWithdrawals, isTiktokWithdraw, markInProcess, receiveWithdraw, type InProcessRow } from "./wdProcess";

/**
 * Tombol bot withdraw TikTok "Dalam Proses":
 *   wr:<tx>[:r]          → tampilkan pilihan tanggal terima (Hari ini / Kemarin / Pilih tanggal)
 *   wp:<tx>[:r]          → pilihan 7 hari terakhir
 *   wd:<tx>:<yyyymmdd>[:r] → uang diterima tanggal tsb (hari ini = jam sekarang, tanggal lain = 12:00) → dibukukan
 * Akhiran ":r" = dari pesan pengingat harian (pesannya diperbarui berisi WD yang tersisa).
 * Semua callback_data ≤ 64 byte (id transaksi cuid 25 karakter).
 */

export type WdIdent = { userId: string; telegramUserId: string; canConfirm: boolean; user: { name: string }; perms: ReadonlySet<string> };

const isApprover = (i: WdIdent) => i.canConfirm && i.perms.has("finance.approve");

/** Tombol per WD untuk pesan pengingat */
export function reminderButtons(rows: Pick<InProcessRow, "id" | "number" | "amount">[]): InlineButton[][] {
  return rows.slice(0, 30).map((r) => [{ text: `💰 Uang diterima ${r.number.slice(-4)} · ${idr(r.amount)}`, callback_data: `wr:${r.id}:r` }]);
}

export async function reminderMessage() {
  const rows = await inProcessWithdrawals();
  const text = inProcessReminderText(rows, esc);
  return { rows, text, buttons: reminderButtons(rows) };
}

function dateButtons(txId: string, suffix: string, all: boolean): InlineButton[][] {
  const today = todayStr();
  const s = suffix ? `:${suffix}` : "";
  if (!all) {
    return [
      [
        { text: `Hari ini (${fmtDate(today)}, jam ${nowTimeStr()})`, callback_data: `wd:${txId}:${today.replace(/-/g, "")}${s}` },
      ],
      [
        { text: `Kemarin (${fmtDate(addDays(today, -1))})`, callback_data: `wd:${txId}:${addDays(today, -1).replace(/-/g, "")}${s}` },
        { text: "📅 Pilih tanggal", callback_data: `wp:${txId}${s}` },
      ],
    ];
  }
  const days = [0, 1, 2, 3, 4, 5, 6].map((k) => addDays(today, -k));
  return chunk(days.map((d, k) => ({ text: k === 0 ? "Hari ini" : k === 1 ? "Kemarin" : fmtDate(d), callback_data: `wd:${txId}:${d.replace(/-/g, "")}${s}` })), 3);
}

const FLOW = "wdp";
const proofAsk = (t: { number: string; amount: bigint | number }) =>
  `💰 <b>Uang diterima</b> · ${esc(t.number)} ${idr(t.amount)}\n\n📷 Kirim <b>screenshot bukti</b>:\n• uang masuk di aplikasi bank (mutasi), atau\n• Seller Center TikTok yang menunjukkan dana <i>sudah ditransfer ke bank</i>.\nHarus terlihat <b>nominal, tanggal & jam</b>. Tanggal & jam di bukti dipakai sebagai waktu terima.`;

export async function wdCallback(ident: WdIdent, cbId: string, chatId: string, messageId: number, data: string) {
  const [action, txId, a, b] = data.split(":");
  const fromReminder = (action === "wd" ? b : a) === "r";
  const back: InlineButton[] = [{ text: "◀ Kembali", callback_data: fromReminder ? "wl:r" : `back:${txId}` }];
  const t = txId && txId !== "r" ? await prisma.financeTransaction.findUnique({ where: { id: txId } }) : null;
  if (action === "wl") {
    // Kembali ke daftar pengingat
    const m = await reminderMessage();
    await editTelegram(chatId, messageId, m.text ?? "✅ Tidak ada withdraw TikTok dalam proses.", m.buttons);
    return answerCallback(cbId, "");
  }
  if (!t) return answerCallback(cbId, "Transaksi tidak ditemukan");
  if (t.status === "DIBUKUKAN") return answerCallback(cbId, `${t.number} sudah dibukukan`);
  const pending = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status);
  if (t.status !== "DALAM_PROSES" && !pending) return answerCallback(cbId, `${t.number} tidak dalam proses`);
  if (pending && (!(await isTiktokWithdraw(t)) || !isApprover(ident))) return answerCallback(cbId, "Hanya Owner/Finance yang dapat mengonfirmasi withdraw");
  if (t.status === "DALAM_PROSES" && !(await canReceive(t.id, { id: ident.userId, canApprove: isApprover(ident) }))) return answerCallback(cbId, "Hanya Owner/Finance atau pembuat transaksi");
  if (action === "wr") {
    // Bukti wajib: tunggu screenshot (foto/PDF) di chat ini
    const data = { id: t.id, r: fromReminder ? 1 : 0, msg: messageId };
    await prisma.botSession.upsert({ where: { chatId }, create: { chatId, userId: ident.userId, flow: FLOW, step: "proof", data }, update: { userId: ident.userId, flow: FLOW, step: "proof", data } });
    await editTelegram(chatId, messageId, proofAsk(t), [back]);
    return answerCallback(cbId, "Kirim screenshot bukti");
  }
  const s = await getSession(chatId);
  const sess = s?.flow === FLOW && s.userId === ident.userId && s.data.id === t.id && s.data.path ? s : null;
  if (action === "wp") {
    // Tanggal manual (bukti tidak terbaca): 7 hari terakhir, hanya penyetuju
    if (!sess) return answerCallback(cbId, "Kirim screenshot bukti dulu");
    await editTelegram(chatId, messageId, `📅 Pilih tanggal uang diterima (cek manual) · ${esc(t.number)}`, [...dateButtons(t.id, fromReminder ? "r" : "", true), back]);
    return answerCallback(cbId, "");
  }
  if (action !== "wd" || !(a === "ok" || /^\d{8}$/.test(a ?? ""))) return answerCallback(cbId, "Tanggal tidak valid");
  if (!sess) return answerCallback(cbId, "Kirim screenshot bukti uang masuk dulu");
  const proofRead = sess.data.read ? (JSON.parse(String(sess.data.read)) as WdProofRead) : null;
  // Bukti Seller Center valid: tanggal terima boleh dipilih (uang masuk bank 1–3 hari setelah ditransfer)
  const sellerOk = proofRead?.source === "seller" && checkWdProof(proofRead, Number(t.amount)).ok;
  const manual = a !== "ok" && !sellerOk;
  if (manual && !isApprover(ident)) return answerCallback(cbId, "Bukti tidak terbaca: hanya Owner/Finance yang dapat menyimpan dengan cek manual");
  const date = a !== "ok" ? `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}` : null;
  const receivedAt = date ? jakartaDateTime(date, date === todayStr() ? nowTimeStr() : sellerOk && date === proofRead?.date && proofRead.time ? proofRead.time : "12:00") : null;
  const actor = { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId };
  const proof = { path: String(sess.data.path), mime: String(sess.data.mime ?? "image/jpeg"), read: proofRead };
  try {
    if (pending) {
      // Dari kartu draft: "Uang sudah diterima" = konfirmasi + langsung dibukukan
      if (t.status !== "MENUNGGU_KONFIRMASI") await submitForConfirmation(t.id, actor, "Dikonfirmasi via Telegram");
      await markInProcess(t.id, actor, "Dikonfirmasi via Telegram");
    }
    const r = await receiveWithdraw(t.id, actor, { receivedAt, canApprove: isApprover(ident), proof, manual });
    await clearSession(chatId);
    const done = `✅ ${esc(t.number)} ${idr(t.amount)} diterima ${fmtDateTime(r.transaction.receivedAt)}${manual ? " (dicek manual)" : ""} & dibukukan (${esc(r.journal.number)}).`;
    await editTelegram(chatId, messageId, done, []);
    const orig = Number(sess.data.msg);
    if (orig) {
      if (Number(sess.data.r)) {
        const m = await reminderMessage();
        await editTelegram(chatId, orig, m.text ?? "Semua withdraw TikTok sudah diterima. 🎉", m.buttons).catch(() => {});
      } else {
        const m = await draftMessage(t.id);
        await editTelegram(chatId, orig, m.text, m.buttons).catch(() => {});
      }
    }
    return answerCallback(cbId, "Dibukukan ✅");
  } catch (e) {
    return answerCallback(cbId, e instanceof FinanceError ? e.message.slice(0, 190) : "Terjadi kesalahan");
  }
}

type TgMsg = { message_id: number; text?: string; caption?: string; photo?: { file_id: string }[]; document?: { file_id: string; mime_type?: string } };

/** Pesan saat menunggu bukti "Uang diterima": foto/PDF dibaca (OCR, AI cadangan) lalu divalidasi. true = ditangani. */
export async function wdProofMessageHook(ident: WdIdent, chatId: string, msg: TgMsg): Promise<boolean> {
  const s = await getSession(chatId);
  if (s?.flow !== FLOW || s.userId !== ident.userId) return false;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/") || text === "📋 Menu") return false;
  const t = await prisma.financeTransaction.findUnique({ where: { id: String(s.data.id) } });
  if (!t || !["DALAM_PROSES", "DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status)) {
    await clearSession(chatId);
    return false;
  }
  const sfx = Number(s.data.r) ? ":r" : "";
  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
  if (!fileId) {
    await sendTelegram(chatId, `${proofAsk(t)}\n\nKetik /batal untuk berhenti.`, { type: "WD_BUKTI" });
    return true;
  }
  const mime = msg.photo?.length ? "image/jpeg" : (msg.document?.mime_type ?? "");
  const buf = await downloadTelegramFile(fileId);
  if (!buf) {
    await sendTelegram(chatId, "Bukti gagal diunduh, coba kirim ulang.", { type: "WD_BUKTI" });
    return true;
  }
  const path = await saveProof(buf, mime).catch((e: Error) => e);
  if (path instanceof Error) {
    await sendTelegram(chatId, `Bukti tidak bisa disimpan: ${esc(path.message)}. Kirim JPG/PNG/WEBP/PDF maks. 5 MB.`, { type: "WD_BUKTI" });
    return true;
  }
  await chatAction(chatId, "typing").catch(() => {});
  const read = await readWdProofFile(buf, mime, Number(t.amount));
  const c = checkWdProof(read, Number(t.amount));
  await prisma.botSession.update({ where: { chatId }, data: { step: "confirm", data: { ...s.data, path, mime, read: JSON.stringify(read) } } });
  if (c.ok && read!.source === "seller") {
    // Seller Center: tanggal = ditransfer; pilih tanggal uang masuk bank (tanggal transfer s/d hari ini)
    const days = Array.from({ length: 8 }, (_, k) => addDays(todayStr(), -k)).filter((d) => d >= read!.date!);
    const buttons: InlineButton[][] = [[{ text: `✅ Diterima ${fmtDate(read!.date)}${read!.time ? ` ${read!.time}` : ""} (sesuai bukti)`.slice(0, 60), callback_data: `wd:${t.id}:ok${sfx}` }], ...chunk(days.map((d) => ({ text: d === todayStr() ? "Hari ini" : d === addDays(todayStr(), -1) ? "Kemarin" : fmtDate(d), callback_data: `wd:${t.id}:${d.replace(/-/g, "")}${sfx}` })), 3)];
    await sendTelegram(chatId, `✅ <b>Bukti valid</b> (Seller Center) · ${esc(t.number)}\nNominal ${idr(t.amount)} cocok · ditransfer ${fmtDate(read!.date)}${read!.time ? ` jam ${read!.time}` : ""}\n\nℹ️ ${SELLER_NOTE}\n\nKapan uangnya masuk bank?`, { type: "WD_BUKTI", buttons });
  } else if (c.ok) {
    await sendTelegram(chatId, `✅ <b>Bukti valid</b> · ${esc(t.number)}\nNominal ${idr(t.amount)} cocok · tanggal ${fmtDate(read!.date)}${read!.time ? ` jam ${read!.time}` : ""}\n\nSimpan sebagai uang diterima?`, { type: "WD_BUKTI", buttons: [[{ text: `✅ Simpan: diterima ${fmtDate(read!.date)}${read!.time ? ` ${read!.time}` : ""}`.slice(0, 60), callback_data: `wd:${t.id}:ok${sfx}` }]] });
  } else {
    const approver = isApprover(ident);
    const buttons: InlineButton[][] = approver ? [[{ text: "📅 Sudah saya cek manual, pilih tanggal", callback_data: `wp:${t.id}${sfx}` }]] : [];
    await sendTelegram(chatId, `⚠️ <b>Bukti belum valid</b> · ${esc(t.number)} ${idr(t.amount)}\n${esc(c.issues.join("; "))}.\n\n📷 Kirim screenshot lain yang menampilkan nominal, tanggal & jam${approver ? ", atau bila sudah dicek manual tekan tombol di bawah (tercatat di riwayat)" : ""}.`, { type: "WD_BUKTI", buttons });
  }
  return true;
}

export type SellerShotCtx = { i: WdIdent & { canSubmit: boolean }; chatId: string };

/**
 * Foto bebas berisi "Detail penarikan dana" Seller Center TikTok (dibaca OCR):
 * - No. Referensi sudah tercatat → WD Dalam Proses + "Berhasil ditransfer" = uang diterima otomatis; selain itu duplikat pasti.
 * - Cocok dengan WD Dalam Proses (nominal + tanggal pengajuan) → uang diterima otomatis bila sudah "Berhasil ditransfer".
 * - Selain itu: draft WD baru (Saldo Penjual TikTok → Seabank 5984, toko MG/DL dari keterangan), konfirmasi sekali "Simpan".
 */
export async function handleSellerScreenshot(ctx: SellerShotCtx, w: SellerWithdrawal, o: { caption: string; proofPath: string | null; messageId: string; ocrText: string }) {
  const { chatId, i } = ctx;
  const actor = { id: i.userId, name: i.user.name, telegramId: i.telegramUserId };
  const ref = w.ref ? ` (No. Ref ${esc(w.ref)})` : "";
  const existing = await findInProcessFor(w);
  if (existing) {
    if (existing.status === "DALAM_PROSES" && w.transferred && o.proofPath) {
      if (!(await canReceive(existing.id, { id: i.userId, canApprove: isApprover(i) }))) {
        await sendTelegram(chatId, `${esc(existing.number)} masih Dalam Proses. Hanya Owner/Finance atau pembuatnya yang dapat menandai uang diterima.`);
        return;
      }
      try {
        const r = await receiveWithdraw(existing.id, actor, { canApprove: isApprover(i), proof: { path: o.proofPath, mime: "image/jpeg", read: sellerProofRead(w) } });
        const m = await draftMessage(existing.id);
        await sendTelegram(chatId, `✅ <b>Uang diterima otomatis</b>${ref}\n${esc(existing.number)} ${idr(existing.amount)} berhasil ditransfer ${fmtDateTime(r.transaction.receivedAt)} · jurnal ${esc(r.journal.number)}\n\n${m.text}`, { buttons: m.buttons, type: "WD_BUKTI" });
      } catch (e) {
        await sendTelegram(chatId, `⚠️ ${esc(e instanceof FinanceError ? e.message : "Gagal menandai uang diterima")}`);
      }
      return;
    }
    const m = await draftMessage(existing.id);
    await sendTelegram(chatId, `⚠️ <b>Duplikat</b>: withdraw ini${ref} sudah tercatat sebagai ${esc(existing.number)} · ${STATUS_LABEL[existing.status]}. Tidak dicatat lagi.${existing.status === "DALAM_PROSES" ? "\nKirim screenshot setelah tahap \"Berhasil ditransfer\" muncul untuk menyelesaikannya." : ""}\n\n${m.text}`, { buttons: m.buttons, type: "WD_BUKTI" });
    return;
  }
  if (!w.amount || !(w.submitted || w.transferred)) {
    await sendTelegram(chatId, "Nominal/tanggal di detail penarikan belum terbaca. Kirim ulang screenshot yang lebih jelas (jumlah penarikan, rekening, No. Referensi & progres).");
    return;
  }
  const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const sellers = banks.filter((b) => isTiktokSeller(b));
  const cap = o.caption.toLowerCase();
  const seller = sellers.find((b) => b.aliases.split(",").map((x) => x.trim().toLowerCase()).some((a) => a.length >= 4 && cap.includes(a))) ?? sellers[0];
  if (!seller) {
    await sendTelegram(chatId, "Rekening Saldo Penjual TikTok belum ada di Pengaturan → Rekening.");
    return;
  }
  const dest = await tiktokDestination();
  const stores = await prisma.store.findMany({ where: { active: true } });
  const storeId = matchStore(o.caption, stores);
  const at = w.submitted ?? w.transferred!;
  const draft: DraftInput = {
    direction: "TRANSFER",
    amount: w.amount,
    date: jakartaDateTime(at.date, at.time ?? "12:00").toISOString(),
    accountId: seller.id,
    toAccountId: dest.bank?.id ?? null,
    categoryId: null,
    note: `WD TikTok${w.ref ? ` ref ${w.ref}` : ""}${o.caption ? ` · ${o.caption}` : ""}`.slice(0, 500),
    rawText: o.caption,
    proofPath: o.proofPath,
    aiExtraction: { seller: w, ocrText: o.ocrText.slice(0, 3000) },
    messageId: o.messageId,
    storeId,
    askStore: !storeId,
    withdrawRef: w.ref,
  };
  await createDraft(chatId, i, draft);
  if (w.last4 && w.last4 !== dest.last4) await sendTelegram(chatId, `⚠️ Rekening di bukti ****${esc(w.last4)}, padahal WD TikTok seharusnya masuk ****${esc(dest.last4)}${dest.bank ? ` (${esc(dest.bank.name)})` : ""}. Periksa sebelum menyimpan.`);
}
