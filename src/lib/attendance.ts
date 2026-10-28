import type { AttendanceStatus } from "@prisma/client";
import { jakartaParts, toMinutes } from "./time";

/** Hitung keterlambatan berdasarkan jam mulai shift + toleransi (zona WIB). */
export function evaluateCheckIn(shift: { startTime: string; toleranceMinutes: number }, checkIn: Date): { status: AttendanceStatus; lateMinutes: number } {
  const p = jakartaParts(checkIn);
  const minutes = p.hour * 60 + p.minute;
  const late = Math.max(0, minutes - toMinutes(shift.startTime));
  if (late > shift.toleranceMinutes) return { status: "TERLAMBAT", lateMinutes: late };
  return { status: "HADIR", lateMinutes: late };
}

export const ATT_LABEL: Record<AttendanceStatus, string> = {
  HADIR: "Hadir",
  TERLAMBAT: "Terlambat",
  IZIN: "Izin",
  SAKIT: "Sakit",
  ALPA: "Alpa",
};
