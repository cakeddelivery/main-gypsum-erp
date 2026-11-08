import { prisma } from "./db";
import { idr } from "./money";
import { addDays, dayRange, jakartaParts, todayStr, fmtDay, dateOnly } from "./time";
import { bankBalances } from "./finance";
import { cashMovements, closePeriod } from "./accounting";
import { sendTelegram, telegramConfigured } from "./telegram";
import { lowStockItems } from "./stock";
import { generateAllowancePayroll, generateMonthlyPayroll } from "./payroll";

const SYSTEM_ACTOR = { id: "system", name: "Sistem (terjadwal)" };

/** Teks rekap harian (default: kemarin) */
export async function dailyRecapText(now: Date, forDate?: string) {
  const date = forDate ?? addDays(todayStr(now), -1);
  const { start, end } = dayRange(date);
  const booked = await prisma.financeTransaction.groupBy({ by: ["direction"], where: { status: "DIBUKUKAN", date: { gte: start, lt: end } }, _sum: { amount: true }, _count: true });
  // Total uang masuk/keluar dari semua jurnal kas (termasuk pembelian, gaji, kasbon) — bukan hanya menu Transaksi
  const moves = await cashMovements(start, end);
  const cashIn = moves.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
  const cashOut = moves.filter((m) => m.amount < 0).reduce((s, m) => s - m.amount, 0);
  const pending = await prisma.financeTransaction.groupBy({ by: ["status"], where: { status: { in: ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"] } }, _count: true });
  const prod = await prisma.productionEntry.aggregate({ where: { date: dateOnly(date) }, _sum: { qtyGood: true, qtyReject: true } });
  const finished = await prisma.productionEntry.aggregate({ where: { date: dateOnly(date), stage: "BARANG_JADI" }, _sum: { qtyGood: true } });
  const banks = await bankBalances();
  const low = await lowStockItems();
  const unsent = await prisma.shiftReport.count({ where: { date: dateOnly(date), status: { not: "TERKIRIM" } } });
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
  for (const r of recipients) {
    const res = await sendTelegram(r.chatId!, text, { type: "REKAP_HARIAN" });
    if (res.ok) sent++;
  }
  return { sent, failed: recipients.length - sent };
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
  const closeDay = await autoCloseDay();
  if (p.day === closeDay && minutes >= 9 * 60 && !(await ranToday("job_month_close_last", date))) {
    const auto = await prisma.setting.findUnique({ where: { key: "auto_close_enabled" } });
    await markRan("job_month_close_last", date);
    if ((auto?.value ?? "true") === "true") {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      results.monthClose = await logFailure("TUTUP_BUKU", `${y}-${m}`, async () => {
        const r = await closePeriod(y, m, SYSTEM_ACTOR);
        await prisma.notificationLog.create({ data: { channel: "SISTEM", type: "TUTUP_BUKU", target: `${y}-${m}`, status: "SELESAI", payload: JSON.stringify(r) } });
        return r;
      });
    }
  }
  return results;
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
