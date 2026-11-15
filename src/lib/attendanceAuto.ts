import type { AttendanceStatus, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { addDays, dateOnly, dateStr, todayStr } from "./time";
import { evaluateCheckIn } from "./attendance";
import { nightShiftRunning } from "./workday";
import { AUTO_NOTE, LIBUR_NOTE, SHIFT_NOTE_PREFIX, SYSTEM_VALIDATOR, actualShift, divisionShifts, isShiftDivision, targetStatus } from "./attendanceRules";

export { AUTO_NOTE, LIBUR_NOTE } from "./attendanceRules";

/** Berapa hari ke belakang yang dihitung ulang tiap pagi (hari yang terlewat saat job tidak berjalan tetap terisi) */
const LOOKBACK = 3;
const SYSTEM = { actorName: "Sistem (terjadwal)" };

export type DayChange = {
  employeeId: string;
  name: string;
  date: string;
  kind: "STATUS_BARU" | "STATUS_DIUBAH" | "DIVALIDASI" | "SHIFT_DISESUAIKAN" | "JADWAL_DIISI";
  from?: string | null;
  to?: string | null;
};

const monday = (day: string) => addDays(day, -((dateOnly(day).getUTCDay() + 6) % 7));

/**
 * Hitung status final absensi semua karyawan pada satu hari yang sudah lewat, lalu (bila `apply`) simpan:
 * - hari tanpa catatan → ALPA / LIBUR / IZIN / SAKIT sesuai jadwal & izin (lihat attendanceRules);
 * - status otomatis lama dihitung ulang bila jadwalnya berubah (koreksi manual tidak ditimpa);
 * - absen masuk Cetak/Oven di shift lain dari jadwal → shift & telat mengikuti jam absen, jadwal ikut diperbarui;
 * - absen tanpa jadwal → jadwal hari itu diisi otomatis (dicentang);
 * - semuanya langsung tervalidasi (tidak ada antrean validasi manual). Setiap perubahan dicatat di audit log.
 */
export async function reconcileDay(day: string, opts: { apply: boolean; employeeIds?: string[]; now?: Date } = { apply: true }): Promise<DayChange[]> {
  const now = opts.now ?? new Date();
  const d = dateOnly(day);
  const only = opts.employeeIds ? { id: { in: opts.employeeIds } } : {};
  const [shifts, emps, atts, scheds, week, leaves] = await Promise.all([
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.employee.findMany({ where: { status: "AKTIF", wageType: { not: "BORONGAN" }, joinDate: { not: null, lte: d }, OR: [{ resignDate: null }, { resignDate: { gt: d } }], ...only }, select: { id: true, name: true, division: { select: { shiftCount: true } } } }),
    prisma.attendance.findMany({ where: { date: d, ...(opts.employeeIds ? { employeeId: { in: opts.employeeIds } } : {}) }, include: { employee: { select: { name: true, division: { select: { shiftCount: true } } } } } }),
    prisma.shiftSchedule.findMany({ where: { date: d } }),
    prisma.shiftSchedule.findMany({ where: { date: { gte: dateOnly(monday(day)), lte: dateOnly(addDays(monday(day), 6)) } }, select: { employeeId: true } }),
    prisma.leaveRequest.findMany({ where: { status: "DISETUJUI", dateFrom: { lte: d }, dateTo: { gte: d } }, select: { employeeId: true, kind: true } }),
  ]);
  if (!shifts.length) return [];
  const attOf = new Map(atts.map((a) => [a.employeeId, a]));
  const schedOf = new Map(scheds.map((s) => [s.employeeId, s]));
  const planned = new Set(week.map((s) => s.employeeId));
  const leaveOf = new Map(leaves.map((l) => [l.employeeId, l.kind]));
  const changes: DayChange[] = [];
  const ops: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];
  const validated = { validated: true, validatedBy: SYSTEM_VALIDATOR, validatedAt: new Date() };
  const name = (id: string) => emps.find((e) => e.id === id)?.name ?? attOf.get(id)?.employee.name ?? id;
  const shiftName = (id: string | null | undefined) => shifts.find((s) => s.id === id)?.name ?? null;

  // 1) Hari dengan absen masuk: sesuaikan shift (Cetak/Oven), isi jadwal bila kosong, validasi otomatis
  for (const a of atts) {
    if (!a.checkIn) continue;
    const shiftDiv = isShiftDivision(a.employee.division);
    const sched = schedOf.get(a.employeeId) ?? null;
    let shiftId = a.shiftId;
    const data: Prisma.AttendanceUpdateInput = {};
    // Absen masuk yang jatuh di hari kalender berikutnya (datang telat ke shift malam) tetap memakai shift tercatat
    const nextDay = todayStr(a.checkIn) !== day;
    if (shiftDiv && !nextDay) {
      const act = actualShift(divisionShifts(shifts, a.employee.division.shiftCount), a.checkIn, sched?.shiftId ?? a.shiftId, true);
      if (act && act.id !== a.shiftId) {
        const ev = evaluateCheckIn(act, a.checkIn);
        shiftId = act.id;
        Object.assign(data, { shift: { connect: { id: act.id } }, status: ev.status, lateMinutes: ev.lateMinutes, note: `${SHIFT_NOTE_PREFIX}: ${shiftName(a.shiftId)} → ${act.name}` });
        changes.push({ employeeId: a.employeeId, name: name(a.employeeId), date: day, kind: "SHIFT_DISESUAIKAN", from: shiftName(a.shiftId), to: act.name });
      }
    }
    if (!sched) {
      changes.push({ employeeId: a.employeeId, name: name(a.employeeId), date: day, kind: "JADWAL_DIISI", to: shiftName(shiftId) });
      ops.push((tx) => tx.shiftSchedule.create({ data: { employeeId: a.employeeId, date: d, shiftId } }));
    } else if (shiftDiv && sched.shiftId !== shiftId) {
      if (!changes.some((c) => c.employeeId === a.employeeId && c.kind === "SHIFT_DISESUAIKAN")) changes.push({ employeeId: a.employeeId, name: name(a.employeeId), date: day, kind: "SHIFT_DISESUAIKAN", from: shiftName(sched.shiftId), to: shiftName(shiftId) });
      ops.push((tx) => tx.shiftSchedule.update({ where: { id: sched.id }, data: { shiftId } }));
    }
    if (!a.validated) {
      Object.assign(data, validated);
      changes.push({ employeeId: a.employeeId, name: name(a.employeeId), date: day, kind: "DIVALIDASI", to: a.status });
    }
    if (Object.keys(data).length) ops.push((tx) => tx.attendance.update({ where: { id: a.id }, data }));
  }

  // 2) Hari tanpa absen masuk: status final dari jadwal, izin/sakit, atau libur
  for (const e of emps) {
    const a = attOf.get(e.id) ?? null;
    if (a?.checkIn) continue;
    // Shift malam (lintas tengah malam) yang masih berjalan belum boleh dianggap Alpa
    const sc = schedOf.get(e.id);
    const scShift = sc ? shifts.find((x) => x.id === sc.shiftId) : null;
    if (!a && scShift && nightShiftRunning(now, day, scShift)) continue;
    const t = targetStatus({ scheduled: schedOf.has(e.id), weekPlanned: planned.has(e.id), leave: (leaveOf.get(e.id) as "IZIN" | "SAKIT" | undefined) ?? null, att: a });
    if (!a && t) {
      changes.push({ employeeId: e.id, name: e.name, date: day, kind: "STATUS_BARU", to: t.status });
      const shiftId = schedOf.get(e.id)?.shiftId ?? shifts[0].id;
      ops.push((tx) => tx.attendance.create({ data: { employeeId: e.id, date: d, shiftId, status: t.status, note: t.note, ...validated } }));
    } else if (a && t && (a.status !== t.status || a.note !== t.note)) {
      changes.push({ employeeId: e.id, name: e.name, date: day, kind: "STATUS_DIUBAH", from: a.status, to: t.status });
      ops.push((tx) => tx.attendance.update({ where: { id: a.id }, data: { status: t.status as AttendanceStatus, note: t.note, lateMinutes: 0, ...validated } }));
    } else if (a && !a.validated) {
      changes.push({ employeeId: e.id, name: e.name, date: day, kind: "DIVALIDASI", to: a.status });
      ops.push((tx) => tx.attendance.update({ where: { id: a.id }, data: validated }));
    }
  }
  // Catatan lain yang belum tervalidasi (mis. karyawan borongan / nonaktif): tetap divalidasi apa adanya
  for (const a of atts) {
    if (a.checkIn || a.validated || emps.some((e) => e.id === a.employeeId)) continue;
    changes.push({ employeeId: a.employeeId, name: a.employee.name, date: day, kind: "DIVALIDASI", to: a.status });
    ops.push((tx) => tx.attendance.update({ where: { id: a.id }, data: validated }));
  }

  if (opts.apply && ops.length) {
    await prisma.$transaction(async (tx) => {
      for (const op of ops) await op(tx);
      await tx.auditLog.createMany({
        data: changes.map((c) => ({ actorName: SYSTEM.actorName, action: `ABSEN_OTOMATIS_${c.kind}`, entity: "Attendance", entityId: `${c.employeeId}:${c.date}`, data: { nama: c.name, tanggal: c.date, dari: c.from ?? null, ke: c.to ?? null } })),
      });
    });
  }
  return changes;
}

/**
 * Job 06.00: hitung status final beberapa hari terakhir (sebelum slip gaji & cek konsistensi). Aman diulang.
 * Gaji memakai status final ini: hari hadir dihitung, hari tanpa hadir masuk jatah libur dulu, sisanya bolos.
 */
export async function markMissingAttendance(now: Date = new Date()) {
  const today = todayStr(now);
  const goLive = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value ?? null;
  let created = 0;
  let changed = 0;
  for (let k = LOOKBACK; k >= 1; k--) {
    const day = addDays(today, -k);
    if (goLive && day < goLive) continue;
    const ch = await reconcileDay(day, { apply: true, now });
    created += ch.filter((c) => c.kind === "STATUS_BARU").length;
    changed += ch.length;
  }
  return { created, changed };
}

/** Hari-hari lampau yang perlu dihitung ulang setelah jadwal diubah (hanya yang sudah lewat & setelah go-live) */
export async function reconcileAfterSchedule(dates: string[], employeeIds: string[], now = new Date()) {
  const today = todayStr(now);
  const goLive = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value ?? "0000";
  const days = [...new Set(dates)].filter((x) => x < today && x >= goLive).sort();
  let n = 0;
  for (const day of days) n += (await reconcileDay(day, { apply: true, employeeIds, now })).length;
  return n;
}

