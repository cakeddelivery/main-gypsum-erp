import { prisma } from "./db";
import { addDays, dateOnly, todayStr } from "./time";
import { shiftWindow } from "./workday";
import { dateOnly as dOnly, jakartaDateTime } from "./time";
import { dayOffReminderText, dayOffWindow } from "./dayOff";
import { sendPush } from "./push";

/**
 * Pengingat absen & laporan shift (push + popup di aplikasi):
 *  - JADWAL : SETIAP HARI 08.00 WIB, ke yang dijadwalkan masuk hari itu: "Jadwal kerja hari ini: Shift X HH:MM–HH:MM · jangan lupa absen masuk";
 *  - LIBUR  : SETIAP JUMAT 08.00 WIB, ke karyawan yang belum mengajukan libur minggu depan (teks bisa diganti: Setting pengingat_libur_teks), klik → halaman pengajuan;
 *  - MASUK  : 30 menit sebelum jam mulai shift terjadwal, bila belum absen masuk (dan tidak libur/izin/sakit);
 *  - LAPORAN: 30 menit sebelum jam selesai shift, bila sudah absen masuk, belum pulang, dan laporan divisi untuk shift itu belum terkirim.
 * Hanya karyawan yang bersangkutan. Shift lintas tengah malam (S2) memakai tanggal kerja = tanggal mulai shift.
 * Push dikirim sekali per jenis+karyawan+tanggal (ReminderLog); popup dihitung langsung dari kondisi saat ini.
 */
export const REMIND_BEFORE_MIN = 30;
/** Popup pengingat laporan masih tampil sampai sekian menit setelah jam selesai (selama belum pulang & laporan belum terkirim) */
export const REPORT_GRACE_MIN = 60;
/** Jam pengingat harian (WIB) */
export const DAILY_REMINDER_HHMM = "08:00";
export const DAYOFF_URL = "/absensi?tab=izin#libur";

export type ReminderItem = { kind: "MASUK" | "LAPORAN" | "JADWAL" | "LIBUR"; key: string; employeeId: string; userId: string | null; title: string; body: string; url: string };
type ShiftT = { id: string; name: string; startTime: string; endTime: string };

const minutesLeft = (target: Date, now: Date) => Math.ceil((target.getTime() - now.getTime()) / 60000);

/** Pengingat masuk jatuh tempo? (30 menit sebelum mulai sampai jam selesai shift) */
export function checkInDue(now: Date, date: string, s: ShiftT) {
  const w = shiftWindow(date, s);
  return now.getTime() >= w.start.getTime() - REMIND_BEFORE_MIN * 60000 && now.getTime() < w.end.getTime();
}

/** Pengingat laporan jatuh tempo? (30 menit sebelum selesai sampai REPORT_GRACE_MIN setelahnya) */
export function reportDue(now: Date, date: string, s: ShiftT) {
  const w = shiftWindow(date, s);
  return now.getTime() >= w.end.getTime() - REMIND_BEFORE_MIN * 60000 && now.getTime() < w.end.getTime() + REPORT_GRACE_MIN * 60000;
}

export function checkInText(now: Date, date: string, s: ShiftT) {
  const left = minutesLeft(shiftWindow(date, s).start, now);
  return { title: `${s.name} segera mulai`, body: `${s.name} mulai ${s.startTime}, ${left > 0 ? `${left} menit lagi` : "sudah dimulai"}. Jangan lupa absen masuk.` };
}

export function scheduleText(s: ShiftT) {
  return { title: "Jadwal kerja hari ini", body: `Jadwal kerja hari ini: ${s.name} ${s.startTime}–${s.endTime} · jangan lupa absen masuk` };
}

export function reportText(division: string) {
  return { title: "Kirim laporan shift", body: `Kirim laporan shift ${division} sebelum pulang.` };
}

/**
 * Semua pengingat yang berlaku sekarang (semua karyawan, atau satu karyawan bila employeeId diisi).
 * Tanggal kerja yang ditinjau: kemarin (shift malam yang melewati tengah malam), hari ini, dan besok (shift mulai lewat tengah malam).
 */
export async function dueReminders(now: Date = new Date(), employeeId?: string): Promise<ReminderItem[]> {
  const today = todayStr(now);
  const days = [addDays(today, -1), today, addDays(today, 1)];
  const dayDates = days.map((d) => dateOnly(d));
  const empWhere = employeeId ? { employeeId } : {};
  const [shifts, scheds, atts, leaves] = await Promise.all([
    prisma.shift.findMany({ where: { active: true }, select: { id: true, name: true, startTime: true, endTime: true } }),
    prisma.shiftSchedule.findMany({ where: { date: { in: dayDates }, ...empWhere, employee: { status: "AKTIF" } }, select: { employeeId: true, shiftId: true, date: true, employee: { select: { divisionId: true, division: { select: { name: true, active: true, reportTemplate: true } }, user: { select: { id: true, active: true } } } } } }),
    prisma.attendance.findMany({ where: { date: { in: dayDates }, ...empWhere }, select: { employeeId: true, date: true, shiftId: true, status: true, checkIn: true, checkOut: true } }),
    prisma.leaveRequest.findMany({ where: { status: "DISETUJUI", dateFrom: { lte: dayDates[2] }, dateTo: { gte: dayDates[0] }, ...empWhere }, select: { employeeId: true, dateFrom: true, dateTo: true } }),
  ]);
  const shiftOf = new Map(shifts.map((s) => [s.id, s]));
  const attOf = new Map(atts.map((a) => [`${a.employeeId}|${a.date.toISOString().slice(0, 10)}`, a]));
  const out: ReminderItem[] = [];
  const needReport: { it: ReminderItem; divisionId: string; shiftId: string; date: string }[] = [];

  const masukKeys = new Set<string>();
  // MASUK: dijadwalkan, belum absen masuk, bukan libur/izin/sakit
  for (const sc of scheds) {
    const date = sc.date.toISOString().slice(0, 10);
    const s = shiftOf.get(sc.shiftId);
    if (!s || !sc.employee.user?.active) continue;
    const a = attOf.get(`${sc.employeeId}|${date}`);
    if (a?.checkIn || (a && ["IZIN", "SAKIT", "LIBUR"].includes(a.status))) continue;
    if (leaves.some((l) => l.employeeId === sc.employeeId && l.dateFrom <= sc.date && l.dateTo >= sc.date)) continue;
    if (!checkInDue(now, date, s)) continue;
    const t = checkInText(now, date, s);
    masukKeys.add(`${sc.employeeId}|${date}`);
    out.push({ kind: "MASUK", key: `MASUK:${sc.employeeId}:${date}`, employeeId: sc.employeeId, userId: sc.employee.user.id, title: t.title, body: t.body, url: "/absensi?tab=saya" });
  }

  // JADWAL: tiap hari mulai 08.00 untuk yang dijadwalkan hari ini dan belum absen masuk (tidak dobel dengan pengingat 30 menit)
  if (now.getTime() >= jakartaDateTime(today, DAILY_REMINDER_HHMM).getTime()) {
    for (const sc of scheds) {
      const date = sc.date.toISOString().slice(0, 10);
      if (date !== today || masukKeys.has(`${sc.employeeId}|${date}`)) continue;
      const sh = shiftOf.get(sc.shiftId);
      if (!sh || !sc.employee.user?.active || now.getTime() >= shiftWindow(date, sh).end.getTime()) continue;
      const a = attOf.get(`${sc.employeeId}|${date}`);
      if (a?.checkIn || (a && ["IZIN", "SAKIT", "LIBUR"].includes(a.status))) continue;
      if (leaves.some((l) => l.employeeId === sc.employeeId && l.dateFrom <= sc.date && l.dateTo >= sc.date)) continue;
      const t = scheduleText(sh);
      out.push({ kind: "JADWAL", key: `JADWAL:${sc.employeeId}:${date}`, employeeId: sc.employeeId, userId: sc.employee.user.id, title: t.title, body: t.body, url: "/absensi?tab=saya" });
    }
    // LIBUR: setiap Jumat, yang belum mengajukan libur minggu depan (sampai pukul 23.59)
    const w = dayOffWindow(today);
    if (dOnly(today).getUTCDay() === 5 && w.open) {
      const [users, done, text] = await Promise.all([
        prisma.user.findMany({ where: { active: true, employee: { is: { status: "AKTIF" } }, ...(employeeId ? { employeeId } : { employeeId: { not: null } }) }, select: { id: true, employeeId: true } }),
        prisma.dayOffRequest.findMany({ where: { weekStart: dOnly(w.weekStart), status: { in: ["MENUNGGU", "DISETUJUI"] }, ...empWhere }, select: { employeeId: true } }),
        dayOffReminderText(),
      ]);
      const has = new Set(done.map((x) => x.employeeId));
      for (const u of users) if (u.employeeId && !has.has(u.employeeId)) out.push({ kind: "LIBUR", key: `LIBUR:${u.employeeId}:${w.weekStart}`, employeeId: u.employeeId, userId: u.id, title: text.title, body: text.body, url: DAYOFF_URL });
    }
  }

  // LAPORAN: sudah absen masuk, belum pulang, laporan divisi untuk shift itu belum terkirim
  const working = atts.filter((a) => a.checkIn && !a.checkOut);
  if (working.length) {
    const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(working.map((a) => a.employeeId))] }, status: "AKTIF" }, select: { id: true, divisionId: true, division: { select: { name: true, active: true, reportTemplate: true } }, user: { select: { id: true, active: true } } } });
    const reports = await prisma.shiftReport.findMany({ where: { date: { in: dayDates }, status: { not: "DRAFT" } }, select: { divisionId: true, shiftId: true, date: true } });
    for (const a of working) {
      const e = emps.find((x) => x.id === a.employeeId);
      const s = shiftOf.get(a.shiftId);
      if (!e || !s || !e.user?.active || !e.division.active || !e.division.reportTemplate) continue;
      const date = a.date.toISOString().slice(0, 10);
      if (!reportDue(now, date, s)) continue;
      if (reports.some((r) => r.divisionId === e.divisionId && r.shiftId === a.shiftId && r.date.toISOString().slice(0, 10) === date)) continue;
      const t = reportText(e.division.name);
      needReport.push({ it: { kind: "LAPORAN", key: `LAPORAN:${a.employeeId}:${date}`, employeeId: a.employeeId, userId: e.user.id, title: t.title, body: t.body, url: "/laporan" }, divisionId: e.divisionId, shiftId: a.shiftId, date });
    }
    out.push(...needReport.map((x) => x.it));
  }
  return out;
}

/** Job per menit: kirim push pengingat yang jatuh tempo, sekali per jenis+karyawan+tanggal */
export async function sendShiftTimeReminders(now: Date = new Date()) {
  const items = await dueReminders(now);
  let sent = 0;
  let skipped = 0;
  for (const it of items) {
    if (!it.userId) continue;
    // Catat dulu; kunci yang sudah ada → lewati (dua proses bersamaan tidak mengirim dobel)
    const fresh = await prisma.reminderLog.create({ data: { key: it.key } }).then(() => true, () => false);
    if (!fresh) {
      skipped++;
      continue;
    }
    const r = await sendPush([it.userId], { title: it.title, body: it.body, url: it.url, tag: ({ MASUK: "ingat-masuk", JADWAL: "ingat-jadwal", LIBUR: "libur-minggu-depan", LAPORAN: "ingat-laporan" } as const)[it.kind] });
    sent += r.sent;
  }
  // Bersihkan penanda lama (> 3 hari)
  await prisma.reminderLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 3 * 86400000) } } }).catch(() => {});
  return { kandidat: items.length, perangkat: sent, dilewati: skipped };
}
