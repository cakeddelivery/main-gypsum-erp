import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { addDays, dateOnly, fmtDay, todayStr } from "./time";
import { sendPush } from "./push";
import { esc, sendTelegram } from "./telegram";
import { canDecideLeave } from "./leave";

/**
 * Pengajuan libur MINGGU DEPAN: karyawan memilih hari libur untuk minggu depan (Senin–Minggu) paling lambat
 * JUMAT minggu ini 23.59 WIB. Supervisor/Owner menyetujui atau menolak; disetujui → jadwal hari itu dihapus (libur).
 */
export const DAYOFF_DEADLINE_DOW = 5; // Jumat
export const DAYOFF_MAX_DAYS = 6;
export const DAYOFF_REMINDER_KEY = "pengingat_libur_teks";
export const DAYOFF_REMINDER_DEFAULT = { title: "Ajukan libur minggu depan", body: "Ajukan libur minggu depan paling lambat Jumat." };

/** Senin dari tanggal (YYYY-MM-DD) */
export const mondayOf = (day: string) => addDays(day, -((dateOnly(day).getUTCDay() + 6) % 7));

export type DayOffWindow = { weekStart: string; weekEnd: string; deadline: string; open: boolean };

/** Minggu yang bisa diajukan (minggu depan), batas Jumat minggu ini, dan apakah masih dibuka hari ini (WIB) */
export function dayOffWindow(today: string): DayOffWindow {
  const thisMonday = mondayOf(today);
  const deadline = addDays(thisMonday, DAYOFF_DEADLINE_DOW - 1);
  const weekStart = addDays(thisMonday, 7);
  return { weekStart, weekEnd: addDays(weekStart, 6), deadline, open: today <= deadline };
}

export type DayOffInput = { dates: string[]; none?: boolean };

/** Cek isian (murni, mudah dites). Pesan error atau null. */
export function dayOffError(i: DayOffInput, today: string): string | null {
  const w = dayOffWindow(today);
  if (!w.open) return `Batas pengajuan libur minggu depan sudah lewat (Jumat ${fmtDay(w.deadline)} pukul 23.59). Hubungi Supervisor bila sangat perlu.`;
  if (i.none) return null;
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const uniq = [...new Set(i.dates)];
  if (!uniq.length) return "Pilih minimal satu hari libur";
  if (uniq.some((d) => !ymd.test(d) || d < w.weekStart || d > w.weekEnd)) return `Hari libur harus di minggu depan (${fmtDay(w.weekStart)} – ${fmtDay(w.weekEnd)})`;
  if (uniq.length > DAYOFF_MAX_DAYS) return `Paling banyak ${DAYOFF_MAX_DAYS} hari libur dalam seminggu`;
  return null;
}

type Actor = { id: string; name: string; role: Role; employeeId: string | null };

const rangeText = (dates: string[]) => (dates.length ? [...dates].sort().map((d) => fmtDay(d)).join(", ") : "tanpa libur");

async function approverIds(exceptUserId?: string) {
  const us = await prisma.user.findMany({ where: { active: true, role: { in: ["SUPERVISOR", "OWNER"] }, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) }, select: { id: true } });
  return us.map((u) => u.id);
}

async function telegramTo(userIds: string[], text: string) {
  if (!userIds.length) return;
  const ids = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, userId: { in: userIds }, user: { active: true } }, select: { chatId: true } });
  await Promise.all(ids.map((i) => sendTelegram(i.chatId!, text, { type: "LIBUR_MINGGU_DEPAN" }).catch(() => {})));
}

/** Karyawan mengajukan libur minggu depan (atau menyatakan tidak libur → pengingat berhenti) */
export async function submitDayOff(user: Actor, input: DayOffInput & { reason?: string | null }, now = new Date()) {
  if (!user.employeeId) throw new Error("Akun Anda belum ditautkan ke data karyawan");
  const today = todayStr(now);
  const err = dayOffError(input, today);
  if (err) throw new Error(err);
  const w = dayOffWindow(today);
  const week = dateOnly(w.weekStart);
  const clash = await prisma.dayOffRequest.findFirst({ where: { employeeId: user.employeeId, weekStart: week, status: { in: ["MENUNGGU", "DISETUJUI"] } } });
  if (clash) throw new Error("Anda sudah mengajukan untuk minggu depan. Batalkan pengajuan lama dulu bila ingin mengubah.");
  const dates = input.none ? [] : [...new Set(input.dates)].sort();
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: user.employeeId }, select: { name: true, division: { select: { name: true } } } });
  const r = await prisma.dayOffRequest.create({
    // "Tidak libur" tidak perlu persetujuan
    data: { employeeId: user.employeeId, userId: user.id, weekStart: week, dates, reason: input.reason?.trim().slice(0, 300) || null, ...(dates.length ? {} : { status: "DISETUJUI", decidedBy: "Otomatis", decidedAt: new Date() }) },
  });
  await audit(user, "LIBUR_DIAJUKAN", "DayOffRequest", r.id, { minggu: w.weekStart, tanggal: dates });
  if (dates.length) {
    const ids = await approverIds(user.id);
    const body = `${emp.name} (${emp.division.name}) · ${rangeText(dates)}${r.reason ? `: ${r.reason}` : ""}`;
    await sendPush(ids, { title: "Pengajuan libur minggu depan", body, url: "/absensi?tab=izin", tag: `libur-${r.id}` }).catch(() => {});
    await telegramTo(ids, `🏖 <b>Pengajuan libur minggu depan</b>\n${esc(emp.name)} · ${esc(emp.division.name)}\n${esc(rangeText(dates))}${r.reason ? `\nAlasan: ${esc(r.reason)}` : ""}\n\nSetujui/tolak di menu Absensi → Izin & Sakit.`);
  }
  return r;
}

/** Setujui / tolak (Supervisor atau Owner). Setuju → jadwal hari-hari itu dihapus (libur), kecuali yang sudah absen masuk. */
export async function decideDayOff(user: Actor, id: string, approve: boolean, rejectReason?: string | null) {
  if (!canDecideLeave(user.role)) throw new Error("Hanya Supervisor atau Owner yang dapat menyetujui libur");
  const req = await prisma.dayOffRequest.findUniqueOrThrow({ where: { id }, include: { employee: { select: { id: true, name: true } } } });
  if (req.status !== "MENUNGGU") throw new Error("Pengajuan ini sudah diputuskan");
  if (user.employeeId && req.employeeId === user.employeeId && user.role !== "OWNER") throw new Error("Pengajuan Anda sendiri harus disetujui atasan lain");
  if (!approve && !rejectReason?.trim()) throw new Error("Tulis alasan penolakan");
  let removed = 0;
  await prisma.$transaction(async (tx) => {
    const upd = await tx.dayOffRequest.updateMany({
      where: { id, status: "MENUNGGU" },
      data: { status: approve ? "DISETUJUI" : "DITOLAK", decidedBy: user.name, decidedAt: new Date(), rejectReason: approve ? null : rejectReason!.trim().slice(0, 300) },
    });
    if (!upd.count) throw new Error("Pengajuan ini sudah diputuskan");
    if (!approve) return;
    for (const day of req.dates) {
      const d = dateOnly(day);
      const att = await tx.attendance.findUnique({ where: { employeeId_date: { employeeId: req.employeeId, date: d } } });
      if (att?.checkIn) continue; // sudah terlanjur masuk: jadwal dibiarkan
      removed += (await tx.shiftSchedule.deleteMany({ where: { employeeId: req.employeeId, date: d } })).count;
    }
    await audit(user, "LIBUR_DISETUJUI", "DayOffRequest", id, { tanggal: req.dates, jadwalDihapus: removed }, tx);
  });
  if (!approve) await audit(user, "LIBUR_DITOLAK", "DayOffRequest", id, { alasan: rejectReason });
  const when = rangeText(req.dates);
  const title = approve ? "Libur minggu depan disetujui ✅" : "Libur minggu depan ditolak";
  const body = approve ? `${when} — disetujui ${user.name}. Jadwal sudah libur.` : `${when} — ditolak ${user.name}: ${rejectReason}`;
  if (req.userId) {
    await sendPush([req.userId], { title, body, url: "/absensi?tab=izin", tag: `libur-${id}` }).catch(() => {});
    await telegramTo([req.userId], `${approve ? "✅" : "❌"} <b>${esc(title)}</b>\n${esc(body)}`);
  }
  return { removed };
}

/** Karyawan membatalkan pengajuannya sendiri yang masih menunggu (atau pernyataan "tidak libur" untuk mengubahnya) */
export async function cancelDayOff(user: Actor, id: string, now = new Date()) {
  const r = await prisma.dayOffRequest.deleteMany({ where: { id, employeeId: user.employeeId ?? "-", OR: [{ status: "MENUNGGU" }, { status: "DISETUJUI", dates: { isEmpty: true } }] } });
  if (!r.count) throw new Error("Pengajuan tidak ditemukan atau sudah diputuskan");
  await audit(user, "LIBUR_DIBATALKAN", "DayOffRequest", id);
  void now;
}

/** Teks pengingat (bisa diganti lewat Pengaturan: kunci pengingat_libur_teks = "judul | isi") */
export async function dayOffReminderText() {
  const s = await prisma.setting.findUnique({ where: { key: DAYOFF_REMINDER_KEY } });
  const v = s?.value?.trim();
  if (!v) return DAYOFF_REMINDER_DEFAULT;
  const [t, ...rest] = v.split("|");
  return rest.length ? { title: t.trim() || DAYOFF_REMINDER_DEFAULT.title, body: rest.join("|").trim() || DAYOFF_REMINDER_DEFAULT.body } : { title: DAYOFF_REMINDER_DEFAULT.title, body: v };
}

/** Pengingat Senin–Jumat 08.00: ke semua karyawan aktif yang belum mengajukan untuk minggu depan (hanya bila batas belum lewat) */
export async function sendDayOffReminders(now: Date = new Date()) {
  const today = todayStr(now);
  const w = dayOffWindow(today);
  const dow = dateOnly(today).getUTCDay();
  if (!w.open || dow === 0 || dow === 6) return { skipped: "bukan hari kerja / batas lewat", sent: 0 };
  const [users, done, text] = await Promise.all([
    prisma.user.findMany({ where: { active: true, employee: { is: { status: "AKTIF" } } }, select: { id: true, employeeId: true } }),
    prisma.dayOffRequest.findMany({ where: { weekStart: dateOnly(w.weekStart), status: { in: ["MENUNGGU", "DISETUJUI"] } }, select: { employeeId: true } }),
    dayOffReminderText(),
  ]);
  const has = new Set(done.map((x) => x.employeeId));
  const ids = users.filter((u) => u.employeeId && !has.has(u.employeeId)).map((u) => u.id);
  const r = await sendPush(ids, { title: text.title, body: text.body, url: "/absensi?tab=izin", tag: "libur-minggu-depan" });
  return { penerima: ids.length, ...r };
}

