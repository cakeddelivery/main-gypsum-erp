import type { BalanceCheck, BankAccount } from "@prisma/client";
import { prisma } from "./db";
import { sessionKey } from "./botKit";
import { bankBalances, bankBalancesAt } from "./finance";
import { answerCallback, downloadTelegramFile, editTelegram, esc, sendTelegram, telegramConfigured, type InlineButton } from "./telegram";
import { saveProof } from "./storage";
import { clearSession, getSession } from "./botFlow";
import { idr } from "./money";
import { addDays, dateOnly, dateStr, fmtDay, todayStr } from "./time";
import { appUrl } from "./botDup";

/**
 * Konfirmasi saldo pagi (05.00 WIB): bot mengirim saldo akhir setiap rekening aktif yang bukan Saldo Penjual per
 * kemarin 23.59 WIB + saldo saat ini ke pengecek (setting cek_saldo_penerima; bawaan Jojo) dan selalu ke semua Owner.
 * Per rekening: ✅ Sesuai / ❌ Tidak sesuai. Tidak sesuai → ketik saldo di aplikasi bank,
 * kirim mutasi (foto/screenshot/PDF, boleh beberapa) → Selesai. Owner diberi tahu. Pengingat sekali pukul 12.00.
 *
 * callback_data (≤ 64 byte): cs:ok:<id>, cs:no:<id>, cs:done:<id>, cs:all:<yyyymmdd>
 */

export const RECIPIENT_SETTING = "cek_saldo_penerima";
const FLOW = "cs";

type CsIdent = { userId: string; chatId?: string | null; user: { name: string; role: string } };
type Attachment = { path: string; mime: string };
type Row = BalanceCheck & { bankAccount: BankAccount };

/**
 * Identitas Telegram penerima cek saldo: pengecek (setting; bawaan Jojo) DITAMBAH semua Owner.
 * Owner selalu menerima daftar saldo. Satu chat Telegram hanya dikirimi sekali.
 */
export async function balanceCheckRecipients() {
  const idents = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true } }, include: { user: true } });
  const s = (await prisma.setting.findUnique({ where: { key: RECIPIENT_SETTING } }))?.value?.trim();
  let checkers: typeof idents;
  if (s) {
    const keys = s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    checkers = idents.filter((i) => keys.includes(i.user.username.toLowerCase()) || keys.includes(i.user.id.toLowerCase()) || keys.includes(i.user.name.toLowerCase()));
  } else {
    checkers = idents.filter((i) => /\bjojo\b/i.test(`${i.user.name} ${i.user.username}`));
  }
  const owners = idents.filter((i) => i.user.role === "OWNER");
  const seen = new Set<string>();
  return [...checkers, ...owners].filter((i) => (seen.has(i.chatId!) ? false : (seen.add(i.chatId!), true)));
}

/** Boleh menjawab: penerima cek saldo, atau Owner/Finance */
async function mayAnswer(i: CsIdent) {
  if (i.user.role === "OWNER" || i.user.role === "FINANCE") return true;
  return (await balanceCheckRecipients()).some((r) => r.userId === i.userId);
}

export const checkDate = (now: Date = new Date()) => addDays(todayStr(now), -1);

/** Buat baris cek saldo untuk tanggal tsb (sekali; aman diulang) */
export async function prepareChecks(date: string) {
  const [at, cur] = await Promise.all([bankBalancesAt(date), bankBalances()]);
  for (const b of at.filter((x) => !x.marketplace)) {
    const now = cur.find((c) => c.id === b.id)?.balance ?? b.balance;
    await prisma.balanceCheck.upsert({ where: { date_bankAccountId: { date: dateOnly(date), bankAccountId: b.id } }, create: { date: dateOnly(date), bankAccountId: b.id, bookBalance: BigInt(b.balance), currentBalance: BigInt(now) }, update: {} });
  }
  return rowsOf(date);
}

async function rowsOf(date: string): Promise<Row[]> {
  return prisma.balanceCheck.findMany({ where: { date: dateOnly(date) }, include: { bankAccount: true }, orderBy: { bankAccount: { code: "asc" } } });
}

const open = (r: Pick<BalanceCheck, "status" | "done">) => r.status === "MENUNGGU" || (r.status === "TIDAK_SESUAI" && !r.done);

/** Pesan daftar saldo + tombol (rekening yang belum dijawab) */
export function checkMessage(date: string, rows: Row[], head?: string): { text: string; buttons: InlineButton[][] } {
  const mark = (r: Row) =>
    r.status === "SESUAI" ? "✅ sesuai" : r.status === "TIDAK_SESUAI" ? (r.done ? `❌ tidak sesuai${r.diff != null ? ` (selisih ${signed(Number(r.diff))})` : ""}` : "❌ tidak sesuai — menunggu saldo bank & mutasi") : "⏳ belum dicek";
  const lines = [
    head ?? "🏦 <b>Cek saldo pagi</b>",
    `Saldo buku per ${fmtDay(dateOnly(date))} pukul 23.59 WIB, dibanding saldo di aplikasi bank:`,
    "",
    ...rows.map((r, k) => `${k + 1}. <b>${esc(r.bankAccount.name)}</b>: ${idr(r.bookBalance)}${r.currentBalance !== r.bookBalance ? ` · saat ini ${idr(r.currentBalance)}` : ""}\n    ${mark(r)}`),
  ];
  const pending = rows.filter(open);
  if (pending.length) lines.push("", "Cocokkan dengan aplikasi bank, lalu tekan tombol per rekening.");
  else lines.push("", "Terima kasih, semua rekening sudah dicek. 🙏");
  const buttons: InlineButton[][] = pending.map((r) =>
    r.status === "TIDAK_SESUAI"
      ? [{ text: `✍️ Lanjutkan ${r.bankAccount.name}`.slice(0, 60), callback_data: `cs:no:${r.id}` }]
      : [
          { text: `✅ ${r.bankAccount.name}`.slice(0, 40), callback_data: `cs:ok:${r.id}` },
          { text: "❌ Tidak sesuai", callback_data: `cs:no:${r.id}` },
        ],
  );
  if (pending.filter((r) => r.status === "MENUNGGU").length > 1) buttons.push([{ text: "✅ Semua sesuai", callback_data: `cs:all:${date.replace(/-/g, "")}` }]);
  return { text: lines.join("\n"), buttons };
}

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${idr(Math.abs(n))}`;

/** Job 05.00: siapkan & kirim cek saldo kemarin ke penerima */
export async function sendBalanceCheck(now: Date = new Date()) {
  const date = checkDate(now);
  const rows = await prepareChecks(date);
  if (!rows.length) return { sent: 0, skipped: "tidak ada rekening" };
  const m = checkMessage(date, rows);
  const recipients = await balanceCheckRecipients();
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "CEK_SALDO", target: date, status: "GAGAL", payload: m.text.slice(0, 2000), error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Penerima cek saldo belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  for (const r of recipients) if ((await sendTelegram(r.chatId!, m.text, { buttons: m.buttons, type: "CEK_SALDO" })).ok) sent++;
  return { sent, failed: recipients.length - sent };
}

/** Job 12.00: satu pengingat bila masih ada rekening yang belum dijawab */
export async function sendBalanceCheckReminder(now: Date = new Date()) {
  const date = checkDate(now);
  const rows = await rowsOf(date);
  const pending = rows.filter(open);
  if (!pending.length) return { sent: 0, skipped: "semua sudah dicek" };
  if (pending.every((r) => r.remindedAt)) return { sent: 0, skipped: "sudah diingatkan" };
  const m = checkMessage(date, rows, `⏰ <b>Pengingat cek saldo</b> — ${pending.length} rekening belum dicek`);
  const recipients = await balanceCheckRecipients();
  let sent = 0;
  for (const r of recipients) if ((await sendTelegram(r.chatId!, m.text, { buttons: m.buttons, type: "CEK_SALDO_INGAT" })).ok) sent++;
  // Ditandai walau gagal kirim agar tidak diulang (kegagalan tercatat di log notifikasi)
  await prisma.balanceCheck.updateMany({ where: { id: { in: pending.map((r) => r.id) } }, data: { remindedAt: now } });
  return { sent, failed: recipients.length - sent };
}

/** Saldo yang diketik: "1.234.567", "Rp 1,234,567", "1.234.567,00" */
export function parseBalance(s: string): number | null {
  let t = s.trim().replace(/^rp\.?\s*/i, "");
  const neg = /^[-−]/.test(t);
  t = t.replace(/^[-−]\s*/, "").replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(t)) return null;
  // Sen di belakang (",00" / ".00") dibuang; titik/koma lain = pemisah ribuan
  if (/^\d{1,3}([.,]\d{3})*[.,]\d{2}$/.test(t)) t = t.slice(0, -3);
  const digits = t.replace(/[.,]/g, "");
  if (digits.length > 13) return null;
  return (neg ? -1 : 1) * Number(digits);
}

async function answerCheck(row: Row, status: "SESUAI" | "TIDAK_SESUAI", i: CsIdent) {
  await prisma.balanceCheck.update({ where: { id: row.id }, data: { status, checkedById: i.userId, checkedByName: i.user.name, checkedAt: new Date(), ...(status === "SESUAI" ? { done: true, bankBalance: null, diff: null } : {}) } });
}

export async function balanceCheckCallback(i: CsIdent, cbId: string, chatId: string, messageId: number, data: string) {
  const [, act, arg] = data.split(":");
  if (!(await mayAnswer(i))) return answerCallback(cbId, "Anda tidak berwenang mengecek saldo");
  if (act === "all") {
    if (!/^\d{8}$/.test(arg ?? "")) return answerCallback(cbId, "Tanggal tidak valid");
    const date = `${arg.slice(0, 4)}-${arg.slice(4, 6)}-${arg.slice(6, 8)}`;
    const waiting = (await rowsOf(date)).filter((r) => r.status === "MENUNGGU");
    for (const r of waiting) await answerCheck(r, "SESUAI", i);
    const m = checkMessage(date, await rowsOf(date));
    await editTelegram(chatId, messageId, m.text, m.buttons);
    return answerCallback(cbId, waiting.length ? "Semua ditandai sesuai ✅" : "Sudah dicek semua");
  }
  const row = arg ? await prisma.balanceCheck.findUnique({ where: { id: arg }, include: { bankAccount: true } }) : null;
  if (!row) return answerCallback(cbId, "Data cek saldo tidak ditemukan");
  const date = dateStr(row.date);
  if (act === "ok") {
    if (row.status !== "MENUNGGU" && row.done) return answerCallback(cbId, "Rekening ini sudah dicek");
    await answerCheck(row, "SESUAI", i);
    const m = checkMessage(date, await rowsOf(date));
    await editTelegram(chatId, messageId, m.text, m.buttons);
    return answerCallback(cbId, "Sesuai ✅");
  }
  if (act === "no") {
    if (row.done) return answerCallback(cbId, "Rekening ini sudah dicek");
    await answerCheck(row, "TIDAK_SESUAI", i);
    await prisma.botSession.upsert({ where: { chatId: sessionKey(chatId, i.userId) }, create: { chatId: sessionKey(chatId, i.userId), userId: i.userId, flow: FLOW, step: "amt", data: { id: row.id, msg: messageId } }, update: { userId: i.userId, flow: FLOW, step: "amt", data: { id: row.id, msg: messageId } } });
    const m = checkMessage(date, await rowsOf(date));
    await editTelegram(chatId, messageId, m.text, m.buttons);
    await sendTelegram(chatId, `❌ <b>${esc(row.bankAccount.name)}</b> tidak sesuai.\nSaldo buku saat ini: ${idr((await bankBalances()).find((b) => b.id === row.bankAccountId)?.balance ?? 0)}\n\n✍️ Ketik <b>saldo di aplikasi bank</b> sekarang, contoh <code>1.234.567</code>`, { type: "CEK_SALDO" });
    return answerCallback(cbId, "");
  }
  if (act === "done") return finish(i, chatId, row, cbId);
  return answerCallback(cbId, "Aksi tidak dikenal");
}

async function finish(i: CsIdent, chatId: string, row: Row, cbId?: string) {
  const s = await getSession(chatId, i.userId);
  if (row.bankBalance == null) {
    if (cbId) await answerCallback(cbId, "Ketik saldo di aplikasi bank dulu");
    return;
  }
  const att = (row.attachments as Attachment[] | null) ?? [];
  await prisma.balanceCheck.update({ where: { id: row.id }, data: { done: true } });
  if (s?.flow === FLOW) await clearSession(chatId, i.userId);
  const diff = Number(row.diff ?? 0);
  await sendTelegram(chatId, `✅ Tercatat: <b>${esc(row.bankAccount.name)}</b> tidak sesuai, selisih ${signed(diff)} (bank ${idr(row.bankBalance)} vs buku ${idr(row.currentBalance)}), ${att.length} lampiran mutasi. Owner sudah diberi tahu.`, { type: "CEK_SALDO" });
  // Beri tahu Owner (selain yang mengecek)
  const owners = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: "OWNER" }, NOT: { userId: i.userId } } });
  const text = `⚠️ <b>Saldo tidak sesuai</b> (cek ${fmtDay(row.date)})\nRekening: <b>${esc(row.bankAccount.name)}</b>\nSaldo bank: ${idr(row.bankBalance)}\nSaldo buku: ${idr(row.currentBalance)}\nSelisih: <b>${signed(diff)}</b>\nLampiran mutasi: ${att.length}\nDicek oleh ${esc(i.user.name)}\n\n${appUrl()}/finance/cek-saldo`;
  for (const o of owners) await sendTelegram(o.chatId!, text, { type: "CEK_SALDO_SELISIH" }).catch(() => {});
  const msg = Number(s?.data.msg);
  const date = dateStr(row.date);
  if (msg) {
    const m = checkMessage(date, await rowsOf(date));
    await editTelegram(chatId, msg, m.text, m.buttons).catch(() => {});
  }
  if (cbId) await answerCallback(cbId, "Tersimpan ✅");
}

type TgMsg = { message_id: number; text?: string; caption?: string; photo?: { file_id: string }[]; document?: { file_id: string; mime_type?: string; file_name?: string } };

/**
 * Pesan saat isian cek saldo aktif: saldo bank yang diketik, lalu lampiran mutasi. true = sudah ditangani.
 * Perintah (/…) dan tombol menu tidak ditangani di sini (sesi dibatalkan oleh alur biasa).
 */
export async function balanceCheckMessageHook(i: CsIdent, chatId: string, msg: TgMsg): Promise<boolean> {
  const s = await getSession(chatId, i.userId);
  if (s?.flow !== FLOW || s.userId !== i.userId) return false;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/") || text === "📋 Menu") return false;
  const row = await prisma.balanceCheck.findUnique({ where: { id: String(s.data.id) }, include: { bankAccount: true } });
  if (!row) {
    await clearSession(chatId, i.userId);
    return false;
  }
  const doneBtn: InlineButton[][] = [[{ text: "✅ Selesai", callback_data: `cs:done:${row.id}` }]];
  if (s.step === "amt") {
    const n = text ? parseBalance(text) : null;
    if (n == null) {
      await sendTelegram(chatId, `Ketik saldo <b>${esc(row.bankAccount.name)}</b> di aplikasi bank dalam angka, contoh <code>1.234.567</code>. Ketik /batal untuk berhenti.`, { type: "CEK_SALDO" });
      return true;
    }
    const book = (await bankBalances()).find((b) => b.id === row.bankAccountId)?.balance ?? Number(row.currentBalance);
    await prisma.balanceCheck.update({ where: { id: row.id }, data: { bankBalance: BigInt(n), currentBalance: BigInt(book), diff: BigInt(n - book) } });
    await prisma.botSession.update({ where: { chatId: sessionKey(chatId, i.userId) }, data: { step: "file" } });
    await sendTelegram(chatId, `Saldo bank ${idr(n)} · saldo buku ${idr(book)} · selisih <b>${signed(n - book)}</b>.\n\n📎 Sekarang kirim <b>mutasi rekening ${esc(row.bankAccount.name)}</b> (foto, screenshot, atau PDF), boleh beberapa. Tekan <b>Selesai</b> bila sudah.`, { buttons: doneBtn, type: "CEK_SALDO" });
    return true;
  }
  // step "file": lampiran mutasi
  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
  if (!fileId) {
    await sendTelegram(chatId, "Kirim foto/screenshot/PDF mutasi rekening, atau tekan Selesai.", { buttons: doneBtn, type: "CEK_SALDO" });
    return true;
  }
  const mime = msg.photo?.length ? "image/jpeg" : (msg.document?.mime_type ?? "");
  const buf = await downloadTelegramFile(fileId);
  if (!buf) {
    await sendTelegram(chatId, "File gagal diunduh, coba kirim ulang.", { buttons: doneBtn, type: "CEK_SALDO" });
    return true;
  }
  const path = await saveProof(buf, mime).catch((e: Error) => e);
  if (path instanceof Error) {
    await sendTelegram(chatId, `File tidak bisa disimpan: ${esc(path.message)}. Kirim JPG/PNG/WEBP/PDF maks. 5 MB.`, { buttons: doneBtn, type: "CEK_SALDO" });
    return true;
  }
  await addAttachment(row.id, { path, mime });
  const n = ((await prisma.balanceCheck.findUniqueOrThrow({ where: { id: row.id } })).attachments as Attachment[]).length;
  await sendTelegram(chatId, `📎 Lampiran ke-${n} tersimpan. Kirim lagi, atau tekan Selesai.`, { buttons: doneBtn, type: "CEK_SALDO" });
  return true;
}

export async function addAttachment(id: string, a: Attachment) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BalanceCheck" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.balanceCheck.findUniqueOrThrow({ where: { id } });
    await tx.balanceCheck.update({ where: { id }, data: { attachments: [...((cur.attachments as Attachment[] | null) ?? []), a] } });
  });
}
