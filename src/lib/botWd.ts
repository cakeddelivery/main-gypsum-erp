import { prisma } from "./db";
import { FinanceError, submitForConfirmation } from "./finance";
import { answerCallback, editTelegram, esc, type InlineButton } from "./telegram";
import { addDays, fmtDate, jakartaDateTime, nowTimeStr, todayStr } from "./time";
import { idr } from "./money";
import { draftMessage, chunk } from "./botDraft";
import { canReceive, inProcessReminderText, inProcessWithdrawals, isTiktokWithdraw, markInProcess, receiveWithdraw, type InProcessRow } from "./wdProcess";

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
  if (action === "wr" || action === "wp") {
    const head = `💰 <b>Uang diterima</b> · ${esc(t.number)} ${idr(t.amount)}\nKapan uangnya masuk rekening? (lihat riwayat bank)`;
    await editTelegram(chatId, messageId, head, [...dateButtons(t.id, fromReminder ? "r" : "", action === "wp"), back]);
    return answerCallback(cbId, "");
  }
  if (action !== "wd" || !/^\d{8}$/.test(a ?? "")) return answerCallback(cbId, "Tanggal tidak valid");
  const date = `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`;
  const receivedAt = jakartaDateTime(date, date === todayStr() ? nowTimeStr() : "12:00");
  const actor = { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId };
  try {
    if (pending) {
      // Dari kartu draft: "Uang sudah diterima" = konfirmasi + langsung dibukukan
      if (t.status !== "MENUNGGU_KONFIRMASI") await submitForConfirmation(t.id, actor, "Dikonfirmasi via Telegram");
      await markInProcess(t.id, actor, "Dikonfirmasi via Telegram");
    }
    const r = await receiveWithdraw(t.id, actor, { receivedAt, canApprove: isApprover(ident) });
    if (fromReminder) {
      const m = await reminderMessage();
      await editTelegram(chatId, messageId, `✅ ${esc(t.number)} diterima & dibukukan (${esc(r.journal.number)}).\n\n${m.text ?? "Semua withdraw TikTok sudah diterima. 🎉"}`, m.buttons);
    } else {
      const m = await draftMessage(t.id);
      await editTelegram(chatId, messageId, m.text, m.buttons);
    }
    return answerCallback(cbId, "Dibukukan ✅");
  } catch (e) {
    return answerCallback(cbId, e instanceof FinanceError ? e.message.slice(0, 190) : "Terjadi kesalahan");
  }
}
