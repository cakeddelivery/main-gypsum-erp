import { addDays, jakartaDateTime, toMinutes, todayStr } from "./time";
import { isAutoNote } from "./attendanceRules";

/**
 * TANGGAL KERJA = tanggal MULAI shift. Shift yang jam selesainya ≤ jam mulai (mis. Shift 2 16:00–01:00) melewati
 * tengah malam: absen pulang 01:05 tanggal 16 tetap milik tanggal kerja 15.
 */

/** Batas wajar setelah jam selesai shift malam: sampai kapan absen pulang masih dihitung milik tanggal kerja kemarin */
export const NIGHT_GRACE_HOURS = 6;
/** Setelah absen pulang shift malam, kartu "Sudah absen pulang" tanggal kerja kemarin masih ditampilkan selama ini */
export const DONE_SHOW_MINUTES = 60;

type ShiftTime = { startTime: string; endTime: string };

export const crossesMidnight = (s: ShiftTime) => toMinutes(s.endTime) <= toMinutes(s.startTime);

/** Jam mulai & selesai shift (instan UTC) untuk satu tanggal kerja; shift lintas tengah malam selesai esok hari */
export function shiftWindow(date: string, s: ShiftTime) {
  return { start: jakartaDateTime(date, s.startTime), end: jakartaDateTime(crossesMidnight(s) ? addDays(date, 1) : date, s.endTime) };
}

/** Pulang cepat / lembur (menit) terhadap jam selesai shift tanggal kerja itu — benar melewati 00:00 */
export function checkoutDiff(date: string, s: ShiftTime, checkOut: Date) {
  const diff = Math.round((checkOut.getTime() - shiftWindow(date, s).end.getTime()) / 60000);
  return { earlyMinutes: Math.max(0, -diff), overtimeMinutes: Math.max(0, diff) };
}

export type PrevDay = {
  att: { checkIn: Date | null; checkOut: Date | null; note?: string | null; shift: ShiftTime } | null;
  sched: { shift: ShiftTime } | null;
};

/**
 * Apakah saat `now` karyawan masih berada di tanggal kerja KEMARIN (shift malam)?
 *  - "pulang": absen masuk kemarin di shift lintas hari belum pulang, dan belum lewat jam selesai + batas wajar;
 *  - "selesai": baru saja absen pulang shift malam kemarin (kartu selesai masih ditampilkan sebentar);
 *  - "masuk": belum absen, jadwal kemarin shift lintas hari dan sekarang masih di dalam jam shift itu (datang telat);
 *  - null: pakai tanggal hari ini (semua divisi non-shift malam tidak terpengaruh).
 */
export function carryOver(now: Date, yesterday: string, p: PrevDay): "pulang" | "selesai" | "masuk" | null {
  const a = p.att;
  if (a?.checkIn) {
    if (!crossesMidnight(a.shift)) return null;
    const end = shiftWindow(yesterday, a.shift).end.getTime();
    if (!a.checkOut) return now.getTime() < end + NIGHT_GRACE_HOURS * 3600_000 ? "pulang" : null;
    return now.getTime() - a.checkOut.getTime() < DONE_SHOW_MINUTES * 60_000 && now.getTime() < end + NIGHT_GRACE_HOURS * 3600_000 ? "selesai" : null;
  }
  if (a && !isAutoNote(a.note)) return null; // izin/sakit/koreksi manual kemarin (Alpa otomatis boleh ditimpa absen telat)
  if (p.sched && crossesMidnight(p.sched.shift)) {
    const w = shiftWindow(yesterday, p.sched.shift);
    if (now >= w.start && now < w.end) return "masuk";
  }
  return null;
}

/** Tanggal kerja yang dipakai untuk absen saat ini (pure; data kemarin sudah dibaca pemanggil) */
export function workdayFor(now: Date, p: PrevDay): { date: string; carried: ReturnType<typeof carryOver> } {
  const today = todayStr(now);
  const y = addDays(today, -1);
  const c = carryOver(now, y, p);
  return { date: c ? y : today, carried: c };
}

/** Shift malam tanggal `date` masih berjalan saat `now`? (belum boleh dianggap Alpa) */
export const nightShiftRunning = (now: Date, date: string, s: ShiftTime) => crossesMidnight(s) && now < shiftWindow(date, s).end;
