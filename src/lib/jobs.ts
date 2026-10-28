import { prisma } from "./db";
import { idr } from "./money";
import { addDays, dayRange, jakartaParts, todayStr, fmtDay, dateOnly } from "./time";
import { bankBalances } from "./finance";
import { closePeriod } from "./accounting";
import { sendTelegram, telegramConfigured } from "./telegram";
import { lowStockItems } from "./stock";

const SYSTEM_ACTOR = { id: "system", name: "Sistem (terjadwal)" };

/** Teks rekap harian (default: kemarin) */
export async function dailyRecapText(now: Date, forDate?: string) {
  const date = forDate ?? addDays(todayStr(now), -1);
  const { start, end } = dayRange(date);
  const booked = await prisma.financeTransaction.groupBy({ by: ["direction"], where: { status: "DIBUKUKAN", date: { gte: start, lt: end } }, _sum: { amount: true }, _count: true });
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
    `Pemasukan: ${idr(g("MASUK")?._sum.amount ?? 0)} (${g("MASUK")?._count ?? 0} trx)`,
    `Pengeluaran: ${idr(g("KELUAR")?._sum.amount ?? 0)} (${g("KELUAR")?._count ?? 0} trx)`,
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
 * - 07.00 WIB: rekap harian Telegram
 * - Tanggal 1 pukul 09.00 WIB: tutup buku bulan sebelumnya
 */
export async function runDueJobs(now: Date = new Date()) {
  const p = jakartaParts(now);
  const date = todayStr(now);
  const results: Record<string, unknown> = {};
  const minutes = p.hour * 60 + p.minute;
  if (minutes >= 7 * 60 && !(await ranToday("job_daily_recap_last", date))) {
    await markRan("job_daily_recap_last", date);
    results.dailyRecap = await sendDailyRecap(now);
  }
  if (p.day === 1 && minutes >= 9 * 60 && !(await ranToday("job_month_close_last", date))) {
    const auto = await prisma.setting.findUnique({ where: { key: "auto_close_enabled" } });
    await markRan("job_month_close_last", date);
    if ((auto?.value ?? "true") === "true") {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      results.monthClose = await closePeriod(y, m, SYSTEM_ACTOR);
      await prisma.notificationLog.create({ data: { channel: "SISTEM", type: "TUTUP_BUKU", target: `${y}-${m}`, status: "SELESAI", payload: JSON.stringify(results.monthClose) } });
    }
  }
  return results;
}
