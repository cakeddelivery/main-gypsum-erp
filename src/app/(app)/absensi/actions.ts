"use server";
import { prisma } from "@/lib/db";
import { action, str, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { evaluateCheckIn } from "@/lib/attendance";
import { addDays, dateOnly, jakartaDateTime, todayStr } from "@/lib/time";
import { ForbiddenError } from "@/lib/auth";
import type { AttendanceStatus } from "@prisma/client";

export const checkIn = action(
  "attendance.self",
  async (fd, user) => {
    if (!user.employeeId) throw new Error("Akun Anda belum ditautkan ke data karyawan");
    const date = todayStr();
    const sched = await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
    const shiftId = sched?.shiftId ?? str(fd, "shiftId");
    if (!shiftId) throw new Error("Pilih shift");
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    const exists = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
    if (exists) throw new Error("Anda sudah absen masuk hari ini");
    const now = new Date();
    const ev = evaluateCheckIn(shift, now);
    const a = await prisma.attendance.create({ data: { employeeId: user.employeeId, shiftId, date: dateOnly(date), checkIn: now, status: ev.status, lateMinutes: ev.lateMinutes } });
    await audit(user, "ABSEN_MASUK", "Attendance", a.id, ev);
    return ev.status === "TERLAMBAT" ? `Absen tercatat — terlambat ${ev.lateMinutes} menit` : "Absen masuk tercatat";
  },
  ["/absensi", "/"],
);

export const checkOut = action(
  "attendance.self",
  async (_fd, user) => {
    if (!user.employeeId) throw new Error("Akun belum ditautkan ke karyawan");
    const a = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(todayStr()) } } });
    if (!a?.checkIn) throw new Error("Belum absen masuk");
    if (a.checkOut) throw new Error("Sudah absen pulang");
    await prisma.attendance.update({ where: { id: a.id }, data: { checkOut: new Date() } });
    await audit(user, "ABSEN_PULANG", "Attendance", a.id);
    return "Absen pulang tercatat";
  },
  ["/absensi"],
);

async function guardEmployee(employeeId: string, user: { role: string; divisionId: string | null }) {
  if (user.role !== "KAPTEN_DIVISI" || !user.divisionId) return;
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  if (e.divisionId !== user.divisionId) throw new ForbiddenError();
}

/** Input / koreksi absensi manual oleh admin/kapten (izin, sakit, alpa, jam masuk) */
export const saveAttendance = action(
  "attendance.manage",
  async (fd, user) => {
    const employeeId = str(fd, "employeeId");
    await guardEmployee(employeeId, user);
    const date = str(fd, "date");
    const shiftId = str(fd, "shiftId");
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    let status = str(fd, "status") as AttendanceStatus;
    const time = optStr(fd, "checkIn");
    let lateMinutes = 0;
    let checkIn: Date | null = null;
    if (time && (status === "HADIR" || status === "TERLAMBAT")) {
      checkIn = jakartaDateTime(date, time);
      const ev = evaluateCheckIn(shift, checkIn);
      status = ev.status;
      lateMinutes = ev.lateMinutes;
    }
    const data = { shiftId, status, lateMinutes, checkIn, note: optStr(fd, "note"), validated: true, validatedBy: user.name, validatedAt: new Date() };
    const a = await prisma.attendance.upsert({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, create: { employeeId, date: dateOnly(date), ...data }, update: data });
    await audit(user, "ABSENSI_DIATUR", "Attendance", a.id, data);
    return "Absensi tersimpan & tervalidasi";
  },
  ["/absensi"],
);

export const validateAttendance = action(
  "attendance.manage",
  async (fd, user) => {
    const ids = fd.getAll("ids").map(String);
    if (!ids.length) throw new Error("Pilih minimal satu absensi");
    const where = { id: { in: ids }, ...(user.role === "KAPTEN_DIVISI" && user.divisionId ? { employee: { divisionId: user.divisionId } } : {}) };
    const r = await prisma.attendance.updateMany({ where, data: { validated: true, validatedBy: user.name, validatedAt: new Date() } });
    await audit(user, "ABSENSI_DIVALIDASI", "Attendance", null, { ids });
    return `${r.count} absensi divalidasi`;
  },
  ["/absensi", "/"],
);

export const saveSchedule = action(
  "attendance.manage",
  async (fd, user) => {
    const ids = fd.getAll("employeeIds").map(String);
    const shiftId = str(fd, "shiftId");
    const from = str(fd, "from");
    const to = str(fd, "to");
    if (!ids.length) throw new Error("Pilih karyawan");
    if (to < from) throw new Error("Tanggal akhir sebelum tanggal awal");
    const days: string[] = [];
    for (let d = from; d <= to && days.length < 62; d = addDays(d, 1)) days.push(d);
    const skipSunday = fd.get("skipSunday") === "on";
    let n = 0;
    for (const employeeId of ids) {
      await guardEmployee(employeeId, user);
      for (const d of days) {
        if (skipSunday && dateOnly(d).getUTCDay() === 0) continue;
        await prisma.shiftSchedule.upsert({ where: { employeeId_date: { employeeId, date: dateOnly(d) } }, create: { employeeId, date: dateOnly(d), shiftId }, update: { shiftId } });
        n++;
      }
    }
    await audit(user, "JADWAL_DIATUR", "ShiftSchedule", null, { ids, shiftId, from, to });
    return `${n} jadwal tersimpan`;
  },
  ["/absensi"],
);
