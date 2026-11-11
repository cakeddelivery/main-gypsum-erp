import { prisma } from "./db";
import { fmtDay } from "./time";

/**
 * Setelah laporan shift dikirim: buat JPG laporan (sama dengan tombol "Unduh JPG") lalu kirim ke penerima rekap
 * dan semua grup Telegram terdaftar. Berjalan di latar belakang; kegagalan dicatat di log notifikasi
 * (laporan tetap terkirim sebagai teks).
 */
export async function sendShiftReportJpg(reportId: string, userId: string, summary: string) {
  const { esc, sendTelegramDocument, telegramConfigured } = await import("./telegram");
  if (!telegramConfigured()) return { sent: 0, skipped: "Telegram belum diatur" };
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { division: true, shift: true } });
  const [recipients, { allowedGroups }] = await Promise.all([
    prisma.telegramIdentity.findMany({ where: { active: true, receiveRecap: true, chatId: { not: null } }, select: { chatId: true } }),
    import("./botGroup"),
  ]);
  const targets = [...new Set([...recipients.map((x) => x.chatId!), ...(await allowedGroups())])];
  if (!targets.length) return { sent: 0, skipped: "tidak ada penerima" };
  const day = r.date.toISOString().slice(0, 10);
  const filename = `laporan-${r.division.code}-${r.shift.code}-${day}.jpg`;
  const caption = `📄 <b>Laporan shift ${esc(r.division.name)} · ${esc(r.shift.name)}</b>\n${fmtDay(r.date)}${summary ? `\n${esc(summary)}` : ""}`.slice(0, 1000);
  let jpg: Buffer;
  try {
    const { renderDocJpg } = await import("./render");
    jpg = await renderDocJpg(userId, `/laporan/${r.id}`, "report-preview");
  } catch (e) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "LAPORAN_SHIFT_JPG", target: r.id, status: "GAGAL", payload: filename, error: (e as Error).message.slice(0, 500) } });
    return { sent: 0, failed: targets.length };
  }
  let sent = 0;
  for (const t of targets) if ((await sendTelegramDocument(t, jpg, filename, caption, { type: "LAPORAN_SHIFT_JPG" })).ok) sent++;
  return { sent, failed: targets.length - sent };
}
