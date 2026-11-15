import { prisma } from "./db";
import { diskInfo, fmtBytes, mediaStore } from "./mediaStore";
import { returnSetting } from "./returns";
import { processVideo } from "./returnVideo";
import { sendTelegram, telegramConfigured } from "./telegram";

const DAY = 86_400_000;

/**
 * Perawatan media retur (harian, 03.00 WIB):
 * 1. Video retur yang Selesai lebih dari N hari (Pengaturan retur_video_hapus_hari, bawaan 60) dihapus dari disk;
 *    data retur, thumbnail & potongan gambar tetap.
 * 2. Unggahan video yang macet > 2 hari ditandai Gagal (sisa file dihapus) → muncul di Cek konsistensi.
 * 3. Video yang tertahan di "diproses" > 1 jam (server sempat mati) diproses ulang.
 */
export async function returnMediaMaintenance(now: Date = new Date()) {
  const keep = await returnSetting("videoKeepDays");
  const old = await prisma.returnMedia.findMany({ where: { kind: "VIDEO", status: { in: ["READY", "PROCESSING", "FAILED"] }, ret: { OR: [{ status: "SELESAI", doneAt: { lt: new Date(now.getTime() - keep * DAY) } }, { cancelledAt: { lt: new Date(now.getTime() - keep * DAY) } }] } } });
  let freed = 0;
  for (const m of old) {
    if (m.storageKey) {
      freed += await mediaStore.size(m.storageKey);
      await mediaStore.remove(m.storageKey);
    }
    await prisma.returnMedia.update({ where: { id: m.id }, data: { status: "DELETED", deletedAt: now, storageKey: null } });
  }
  const stuck = await prisma.returnMedia.findMany({ where: { kind: "VIDEO", status: "UPLOADING", updatedAt: { lt: new Date(now.getTime() - 2 * DAY) } } });
  for (const m of stuck) {
    if (m.storageKey) await mediaStore.remove(m.storageKey);
    await prisma.returnMedia.update({ where: { id: m.id }, data: { status: "FAILED", storageKey: null, error: `Unggahan tidak selesai (${fmtBytes(m.received)} diterima)` } });
  }
  const slow = await prisma.returnMedia.findMany({ where: { kind: "VIDEO", status: "PROCESSING", updatedAt: { lt: new Date(now.getTime() - 3600_000) } }, select: { id: true } });
  for (const m of slow) await processVideo(m.id);
  return { deleted: old.length, freed, failed: stuck.length, reprocessed: slow.length };
}

/** Peringatan disk VPS hampir penuh ke Owner (sekali sehari) bila sisa < X% (Pengaturan disk_peringatan_persen, bawaan 15) */
export async function diskWarning(now: Date = new Date()) {
  const min = await returnSetting("diskWarnPct");
  const d = await diskInfo();
  if (d.freePct >= min) return { ...d, warned: false };
  const used = await prisma.returnMedia.aggregate({ where: { status: { in: ["READY", "PROCESSING"] }, kind: "VIDEO" }, _sum: { size: true }, _count: true });
  const text = [
    "<b>⚠️ Disk server hampir penuh</b>",
    `Sisa ${fmtBytes(d.freeBytes)} dari ${fmtBytes(d.totalBytes)} (${d.freePct}%, batas peringatan ${min}%).`,
    `Video retur tersimpan: ${used._count} file, ${fmtBytes(Number(used._sum.size ?? 0))}.`,
    "Saran: tandai retur yang sudah beres sebagai Selesai (video dihapus otomatis), atau kurangi hari simpan video di Pengaturan.",
  ].join("\n");
  await prisma.notificationLog.create({ data: { channel: "SISTEM", type: "DISK_PENUH", target: now.toISOString().slice(0, 10), status: "PERINGATAN", payload: JSON.stringify(d) } });
  if (!telegramConfigured()) return { ...d, warned: false };
  const owners = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: "OWNER" } } });
  let sent = 0;
  for (const o of owners) if ((await sendTelegram(o.chatId!, text, { type: "DISK_PENUH" })).ok) sent++;
  return { ...d, warned: sent > 0 };
}
