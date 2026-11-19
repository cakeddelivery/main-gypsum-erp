import type { AttendanceStatus } from "@prisma/client";
import { nearestShift } from "./attendance";

/**
 * Aturan status absensi harian OTOMATIS (keputusan Owner 15 Nov 2026: tidak ada lagi antrean validasi manual).
 *  - ada absen masuk                    → HADIR / TERLAMBAT (dihitung saat absen)
 *  - izin/sakit disetujui               → IZIN / SAKIT
 *  - dijadwalkan masuk, tidak absen     → ALPA
 *  - tidak dijadwalkan (tidak dicentang) pada minggu yang jadwalnya sudah diatur → LIBUR
 *  - minggu yang jadwalnya belum diatur, tidak absen → ALPA
 * Catatan yang dibuat manual (koreksi Supervisor/Owner, izin, input admin) tidak pernah ditimpa.
 */

/** Keterangan status yang dibuat sistem (boleh dihitung ulang bila jadwal berubah) */
export const AUTO_NOTE = "Tanpa keterangan (otomatis)";
export const LIBUR_NOTE = "Libur sesuai jadwal (otomatis)";
export const SYSTEM_VALIDATOR = "Sistem (otomatis)";
export const SHIFT_NOTE_PREFIX = "Shift disesuaikan otomatis";
export const isAutoNote = (note: string | null | undefined) => note === AUTO_NOTE || note === LIBUR_NOTE;

export type DayAtt = { status: AttendanceStatus; checkIn: Date | null; note: string | null };
export type DayInput = { scheduled: boolean; weekPlanned: boolean; leave: "IZIN" | "SAKIT" | null; att: DayAtt | null; /** libur disetujui lewat pengajuan libur minggu depan */ dayOff?: boolean };
export type Target = { status: AttendanceStatus; note: string | null };

/**
 * Status final satu karyawan pada satu hari yang sudah lewat. null = catatan yang ada dibiarkan (absen masuk,
 * izin/sakit, atau koreksi manual).
 */
export function targetStatus(d: DayInput): Target | null {
  if (d.att?.checkIn) return null;
  if (d.att && !isAutoNote(d.att.note)) return null;
  if (d.leave) return { status: d.leave, note: "Pengajuan disetujui" };
  if (d.scheduled) return { status: "ALPA", note: AUTO_NOTE };
  if (d.dayOff) return { status: "LIBUR", note: LIBUR_NOTE };
  if (d.weekPlanned) return { status: "LIBUR", note: LIBUR_NOTE };
  return { status: "ALPA", note: AUTO_NOTE };
}

export const SCHEDULE_BONUS_MIN = 90;

/**
 * Shift sebenarnya dari jam absen. Divisi 2 shift (Cetak, Oven): shift terdekat dengan jam masuk, walau jadwalnya
 * shift lain (jadwal ikut diperbarui). Divisi 1 shift: shift jadwal bila ada, selain itu shift terdekat.
 */
export function actualShift<T extends { id: string; startTime: string }>(divShifts: T[], checkIn: Date, scheduledId: string | null, shiftDiv: boolean): T | null {
  const scheduled = divShifts.find((s) => s.id === scheduledId) ?? null;
  if (!shiftDiv && scheduled) return scheduled;
  // Divisi 2 shift: shift terdekat, tetapi shift terjadwal diberi keunggulan 90 menit (S2 yang datang 12:00 tetap S2, bukan S1)
  return nearestShift(divShifts, checkIn, scheduled ? { id: scheduled.id, bonus: SCHEDULE_BONUS_MIN } : undefined) ?? scheduled;
}

/** Shift yang boleh dipakai divisi: shift aktif pertama sebanyak jumlah shift divisi (urut kode) */
export function divisionShifts<T>(activeShifts: T[], shiftCount: number): T[] {
  return activeShifts.slice(0, Math.max(1, Math.min(shiftCount, activeShifts.length)));
}

export const isShiftDivision = (d: { shiftCount: number }) => d.shiftCount >= 2;
