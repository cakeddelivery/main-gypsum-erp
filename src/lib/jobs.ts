import { prisma } from "./db";
import { idr } from "./money";
import { addDays, dayRange, jakartaParts, monthRange, todayStr, fmtDay, dateOnly } from "./time";
import { bankBalances } from "./finance";
import { cashMovements, closePeriod, openPastPeriods } from "./accounting";
import { sendTelegram, telegramConfigured } from "./telegram";
import { lowStockItems } from "./stock";
import { generateAllowancePayroll, generateMonthlyPayroll } from "./payroll";

const SYSTEM_ACTOR = { id: "system", name: "Sistem (terjadwal)" };

/** Teks rekap harian (default: kemarin) */
export async function dailyRecapText(now: Date, forDate?: string) {
  const date = forDate ?? addDays(todayStr(now), -1);
  const { start, end } = dayRange(date);
  const booked = await prisma.financeTransaction.groupBy({ by: ["direction"], where: { status: "DIBUKUKAN", origin: null, date: { gte: start, lt: end } }, _sum: { amount: true }, _count: true });
  // Total uang masuk/keluar dari semua jurnal kas (termasuk pembelian, gaji, kasbon) — bukan hanya menu Transaksi
  const moves = await cashMovements(start, end);
  const cashIn = moves.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
  const cashOut = moves.filter((m) => m.amount < 0).reduce((s, m) => s - m.amount, 0);
  const pending = await prisma.financeTransaction.groupBy({ by: ["status"], where: { status: { in: ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"] } }, _count: true });
  const prod = await prisma.productionEntry.aggregate({ where: { date: dateOnly(date) }, _sum: { qtyGood: true, qtyReject: true } });
  const finished = await prisma.productionEntry.aggregate({ where: { date: dateOnly(date), stage: "BARANG_JADI" }, _sum: { qtyGood: true } });
  const banks = await bankBalances();
  const low = await lowStockItems();
  const { unsentReportCount } = await import("./shiftReportStock");
  const unsent = await unsentReportCount(date);
  const g = (d: string) => booked.find((b) => b.direction === d);
  const p = (s: string) => pending.find((x) => x.status === s)?._count ?? 0;
  return [
    `<b>📊 Rekap Harian Main Gypsum</b>`,
    `${fmtDay(dateOnly(date))}`,
    ``,
    `<b>Keuangan (dibukukan)</b>`,
    `Uang masuk: ${idr(cashIn)}`,
    `Uang keluar: ${idr(cashOut)} (termasuk pembelian, gaji, kasbon)`,
    `Transaksi dibukukan: ${(g("MASUK")?._count ?? 0) + (g("KELUAR")?._count ?? 0)} masuk/keluar`,
    `Transfer internal: ${idr(g("TRANSFER")?._sum.amount ?? 0)}`,
    ``,
    `<b>Saldo rekening</b>`,
    ...banks.map((b) => `• ${b.name}: ${idr(b.balance)}`),
    ``,
    `<b>Menunggu tindakan</b>`,
    `Draft: ${p("DRAFT")} · Perlu ditinjau: ${p("PERLU_DITINJAU")} · Menunggu konfirmasi: ${p("MENUNGGU_KONFIRMASI")}`,
    ``,
    `<b>Produksi</b>`,
    `Hasil: ${prod._sum.qtyGood ?? 0} pcs · Reject: ${prod._sum.qtyReject ?? 0} pcs · Barang jadi: ${finished._sum.qtyGood ?? 0} pcs`,
    `Laporan shift belum dikirim: ${unsent}`,
    low.length ? `\n⚠️ Stok menipis: ${low.slice(0, 8).map((i) => i.name).join(", ")}` : "",
  ].join("\n");
}

export async function sendDailyRecap(now: Date = new Date()) {
  const date = todayStr(now);
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, receiveRecap: true, chatId: { not: null } } });
  const text = await dailyRecapText(now);
  if (!telegramConfigured() || recipients.length === 0) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "REKAP_HARIAN", target: date, status: "GAGAL", payload: text, error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Belum ada penerima rekap" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  // Rekap juga ke grup terdaftar bila diaktifkan (setting telegram_grup_rekap = 1); bawaan hanya chat pribadi
  const { groupRecapTargets } = await import("./botGroup");
  const targets = [...recipients.map((r) => r.chatId!), ...(await groupRecapTargets())];
  for (const t of targets) {
    const res = await sendTelegram(t, text, { type: "REKAP_HARIAN" });
    if (res.ok) sent++;
  }
  return { sent, failed: targets.length - sent };
}

/** Pengingat harian dana talangan ke Owner & Finance (yang tertaut Telegram), dengan tombol kirim bukti pengembalian */
export async function sendTalanganReminder(now: Date = new Date()) {
  const { talanganSummary, talanganReminderText } = await import("./talangan");
  const { esc } = await import("./telegram");
  const text = talanganReminderText(await talanganSummary(), esc);
  if (!text) return { sent: 0, skipped: "tidak ada talangan" };
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: { in: ["OWNER", "FINANCE"] } } } });
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "TALANGAN", target: todayStr(now), status: "GAGAL", payload: text, error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Owner/Finance belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  for (const r of recipients) {
    const res = await sendTelegram(r.chatId!, `${text}\n\nTekan tombol di bawah lalu kirim foto bukti transfernya.`, { type: "TALANGAN", buttons: [[{ text: "💸 Kirim bukti pengembalian", callback_data: "f:start:tlg" }]] });
    if (res.ok) sent++;
  }
  return { sent, failed: recipients.length - sent };
}

/**
 * Pengingat piutang penjualan jatuh tempo hari ini / lewat jatuh tempo ke Owner & Finance (tertaut Telegram).
 * Sekali per nota per hari: nota yang sudah diingatkan hari ini tidak dikirim lagi.
 */
export async function sendReceivableReminder(now: Date = new Date()) {
  const { dueSales, receivableReminderText, RECEIVABLE_NOTICE } = await import("./botSales");
  const rows = await dueSales(now);
  if (!rows.length) return { sent: 0, skipped: "tidak ada piutang jatuh tempo" };
  const text = receivableReminderText(rows);
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: { in: ["OWNER", "FINANCE"] } } } });
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: RECEIVABLE_NOTICE, target: todayStr(now), status: "GAGAL", payload: text.slice(0, 2000), error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Owner/Finance belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  for (const r of recipients) {
    const res = await sendTelegram(r.chatId!, text, { type: "PIUTANG_PENGINGAT", buttons: [[{ text: "💰 Terima cicilan piutang", callback_data: "f:start:jcil" }]] });
    if (res.ok) sent++;
  }
  // Tandai per nota agar tidak diingatkan dua kali di hari yang sama
  if (sent) await prisma.notificationLog.createMany({ data: rows.map((x) => ({ channel: "TELEGRAM", type: RECEIVABLE_NOTICE, target: x.id, status: "TERKIRIM", payload: x.number })) });
  return { sent, failed: recipients.length - sent, notes: rows.length };
}

/** Peringatan anggaran beban ke Owner (tertaut Telegram): sekali per akun per ambang (80%/100%) per bulan */
export async function sendBudgetNotice(now: Date = new Date()) {
  const { pendingBudgetNotices, markBudgetNoticed, budgetNoticeText } = await import("./budget");
  const { esc } = await import("./telegram");
  const p = await pendingBudgetNotices(now);
  if (!p.items.length) return { sent: 0, skipped: "tidak ada peringatan baru" };
  const text = budgetNoticeText(p.year, p.month, p.items, esc, idr);
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: "OWNER" } } });
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "ANGGARAN", target: todayStr(now), status: "GAGAL", payload: text, error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Owner belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  for (const r of recipients) {
    const res = await sendTelegram(r.chatId!, text, { type: "ANGGARAN" });
    if (res.ok) sent++;
  }
  // Tandai terkirim bila minimal satu Owner menerima, agar tidak diulang tiap hari
  if (sent) await markBudgetNoticed(p.year, p.month, p.items);
  return { sent, failed: recipients.length - sent };
}

/** Pengingat withdraw TikTok Dalam Proses ke Owner & Finance — HANYA bila ada; tombol "Uang diterima" per WD */
export async function sendWdProcessReminder(now: Date = new Date()) {
  const { reminderMessage } = await import("./botWd");
  const m = await reminderMessage();
  if (!m.text) return { sent: 0, skipped: "tidak ada withdraw dalam proses" };
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: { in: ["OWNER", "FINANCE"] } } } });
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "WD_PROSES", target: todayStr(now), status: "GAGAL", payload: m.text.slice(0, 2000), error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Owner/Finance belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  // Juga ke grup terdaftar yang pengingatnya nyala (/pengingatgrup); tombol "Uang diterima" tetap dicek izinnya per penekan
  const { reminderGroups } = await import("./botGroup");
  const targets = [...recipients.map((r) => r.chatId!), ...(await reminderGroups())];
  for (const t of targets) if ((await sendTelegram(t, m.text, { buttons: m.buttons, type: "WD_PROSES" })).ok) sent++;
  return { sent, failed: targets.length - sent, withdrawals: m.rows.length };
}

async function ranToday(key: string, date: string) {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value === date;
}

async function markRan(key: string, date: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value: date }, update: { value: date } });
}

/**
 * Jalankan job yang jatuh tempo (dipanggil tiap menit oleh scheduler / cron):
 * - 06.00 WIB: slip gaji bulanan untuk siklus karyawan yang selesai (gajian H+7)
 * - 07.00 WIB: rekap harian Telegram
 * - 05.00 WIB: cek saldo pagi (saldo kemarin 23.59 per rekening) ke Jojo/penerima cek saldo; 12.00 WIB: satu pengingat bila belum dijawab
 * - 08.00 WIB: pengingat withdraw TikTok Dalam Proses ke Owner & Finance (hanya bila ada)
 * - 08.00 WIB: pengingat dana talangan ke Owner & Finance (bila ada yang belum dikembalikan)
 * - 08.00 WIB: pengingat piutang penjualan jatuh tempo ke Owner & Finance (sekali per nota per hari)
 * - 08.00 WIB: peringatan anggaran beban ≥80% / ≥100% ke Owner (sekali per ambang per akun per bulan)
 * - 19.00 WIB: pengingat order bahan baku (stok akhir shift terakhir ≤ limit) ke Owner & Admin (hanya bila ada)
 * - Tanggal tutup buku (Pengaturan, default 10) pukul 09.00 WIB: tutup buku bulan sebelumnya.
 *   Tidak tanggal 1 agar bukti transaksi akhir bulan yang terlambat masuk masih bisa dibukukan.
 * Job yang gagal dicatat di log notifikasi (tidak diulang tiap menit).
 */
export async function runDueJobs(now: Date = new Date()) {
  const p = jakartaParts(now);
  const date = todayStr(now);
  const results: Record<string, unknown> = {};
  const minutes = p.hour * 60 + p.minute;
  if (minutes >= 6 * 60 && !(await ranToday("job_monthly_payroll_last", date))) {
    await markRan("job_monthly_payroll_last", date);
    results.monthlyPayroll = await logFailure("GAJI_OTOMATIS", date, () => generateMonthlyPayroll(SYSTEM_ACTOR, now));
    results.allowancePayroll = await logFailure("TUNJANGAN_OTOMATIS", date, () => generateAllowancePayroll(SYSTEM_ACTOR, now));
  }
  if (minutes >= 7 * 60 && !(await ranToday("job_daily_recap_last", date))) {
    await markRan("job_daily_recap_last", date);
    results.dailyRecap = await logFailure("REKAP_HARIAN", date, () => sendDailyRecap(now));
  }
  if (minutes >= 5 * 60 && !(await ranToday("job_cek_saldo_last", date))) {
    await markRan("job_cek_saldo_last", date);
    const { sendBalanceCheck } = await import("./balanceCheck");
    results.balanceCheck = await logFailure("CEK_SALDO", date, () => sendBalanceCheck(now));
  }
  if (minutes >= 12 * 60 && !(await ranToday("job_cek_saldo_ingat_last", date))) {
    await markRan("job_cek_saldo_ingat_last", date);
    const { sendBalanceCheckReminder } = await import("./balanceCheck");
    results.balanceCheckReminder = await logFailure("CEK_SALDO_INGAT", date, () => sendBalanceCheckReminder(now));
  }
  if (minutes >= 8 * 60 && !(await ranToday("job_wd_proses_last", date))) {
    await markRan("job_wd_proses_last", date);
    results.wdProcess = await logFailure("WD_PROSES", date, () => sendWdProcessReminder(now));
  }
  if (minutes >= 8 * 60 && !(await ranToday("job_talangan_last", date))) {
    await markRan("job_talangan_last", date);
    results.talangan = await logFailure("TALANGAN", date, () => sendTalanganReminder(now));
  }
  if (minutes >= 8 * 60 && !(await ranToday("job_piutang_last", date))) {
    await markRan("job_piutang_last", date);
    results.receivable = await logFailure("PIUTANG_JATUH_TEMPO", date, () => sendReceivableReminder(now));
  }
  if (minutes >= 8 * 60 && !(await ranToday("job_budget_last", date))) {
    await markRan("job_budget_last", date);
    results.budget = await logFailure("ANGGARAN", date, () => sendBudgetNotice(now));
  }
  if (minutes >= 19 * 60 && !(await ranToday("job_order_bahan_last", date))) {
    await markRan("job_order_bahan_last", date);
    const { sendMaterialOrderReminder } = await import("./shiftReportStock");
    results.materialOrder = await logFailure("ORDER_BAHAN", date, () => sendMaterialOrderReminder(now));
  }
  const closeDay = await autoCloseDay();
  if (p.day === closeDay && minutes >= 9 * 60 && !(await ranToday("job_month_close_last", date))) {
    const auto = await prisma.setting.findUnique({ where: { key: "auto_close_enabled" } });
    await markRan("job_month_close_last", date);
    if ((auto?.value ?? "true") === "true") {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      results.monthClose = await logFailure("TUTUP_BUKU", `${y}-${m}`, () => closeDueMonths({ year: y, month: m }, now));
    }
  }
  return results;
}

/**
 * Tutup buku otomatis: bulan lalu + semua bulan lebih lama yang masih terbuka (yang punya jurnal), dari yang paling lama.
 * Transaksi yang belum final (draft/perlu ditinjau/menunggu konfirmasi) bertanggal di bulan itu tidak menghalangi
 * penutupan, tetapi dilaporkan ke Owner (Telegram) dan log notifikasi; saat dibukukan nanti tanggalnya harus di periode terbuka.
 */
export async function closeDueMonths(upTo: { year: number; month: number }, now: Date = new Date()) {
  const months = await openPastPeriods(upTo);
  const closed: { period: string; depreciation: number; pending: number }[] = [];
  for (const { year, month } of months) {
    const { start, end } = monthRange(year, month);
    const pending = await prisma.financeTransaction.count({ where: { status: { in: ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"] }, date: { gte: start, lt: end } } });
    const r = await closePeriod(year, month, SYSTEM_ACTOR);
    const period = `${year}-${month}`;
    closed.push({ period, depreciation: r.depreciation, pending });
    await prisma.notificationLog.create({ data: { channel: "SISTEM", type: "TUTUP_BUKU", target: period, status: "SELESAI", payload: JSON.stringify({ ...r, pending }) } });
  }
  const warn = closed.filter((c) => c.pending > 0);
  if (warn.length) {
    const text = `⚠️ Tutup buku otomatis: ${warn.map((c) => `${c.pending} transaksi belum final bertanggal ${c.period}`).join(", ")}. Periode sudah dikunci; saat membukukan, ubah tanggalnya ke periode yang masih terbuka (atau Owner membuka kembali periode).`;
    await prisma.notificationLog.create({ data: { channel: "SISTEM", type: "TUTUP_BUKU", target: todayStr(now), status: "PERINGATAN", payload: text } });
    const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: "OWNER" } } });
    if (telegramConfigured()) for (const r of recipients) await sendTelegram(r.chatId!, text, { type: "TUTUP_BUKU" });
  }
  return { closed };
}

/** Tanggal tutup buku otomatis bulan sebelumnya (Pengaturan, 1–28, default 10) */
export async function autoCloseDay() {
  const s = await prisma.setting.findUnique({ where: { key: "auto_close_day" } });
  const n = Math.floor(Number(s?.value));
  return Number.isFinite(n) && n >= 1 && n <= 28 ? n : 10;
}

/** Jalankan job; bila gagal, catat di log notifikasi agar terlihat (job tidak diulang tiap menit) */
async function logFailure<T>(type: string, target: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`job ${type} gagal:`, e);
    await prisma.notificationLog.create({ data: { channel: "SISTEM", type, target, status: "GAGAL", error: error.slice(0, 500) } }).catch(() => {});
    return { error };
  }
}
