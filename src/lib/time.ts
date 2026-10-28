export const TZ = "Asia/Jakarta";
const OFFSET_MS = 7 * 60 * 60 * 1000; // WIB = UTC+7, tanpa DST

/** Komponen tanggal/jam saat ini di Asia/Jakarta */
export function jakartaParts(d: Date = new Date()) {
  const j = new Date(d.getTime() + OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
    weekday: j.getUTCDay(),
  };
}

/** "YYYY-MM-DD" untuk hari ini di WIB */
export function todayStr(d: Date = new Date()): string {
  const p = jakartaParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Tanggal kalender (kolom @db.Date) dari "YYYY-MM-DD" */
export function dateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("Format tanggal tidak valid");
  return new Date(`${s}T00:00:00.000Z`);
}

export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Jam WIB tertentu pada tanggal tertentu -> instan UTC */
export function jakartaDateTime(date: string, hhmm: string): Date {
  return new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - OFFSET_MS);
}

/** Awal & akhir (eksklusif) bulan dalam WIB, sebagai instan UTC */
export function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1) - OFFSET_MS);
  const end = new Date(Date.UTC(year, month, 1) - OFFSET_MS);
  return { start, end };
}

/** Rentang hari (WIB) sebagai instan UTC */
export function dayRange(date: string) {
  const start = jakartaDateTime(date, "00:00");
  return { start, end: new Date(start.getTime() + 86400000) };
}

export function addDays(date: string, days: number): string {
  return dateStr(new Date(dateOnly(date).getTime() + days * 86400000));
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("id-ID", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" });
}

/** Untuk kolom @db.Date (disimpan 00:00 UTC) — jangan digeser zona waktu */
export function fmtDay(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("id-ID", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleString("id-ID", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WIB";
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
