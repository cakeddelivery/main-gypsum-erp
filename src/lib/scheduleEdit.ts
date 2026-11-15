/**
 * Atur jadwal shift langsung di tabel mingguan.
 * Nilai sel: "" = libur / belum diatur (tidak ada jadwal), "IN" = masuk (divisi 1 shift: jam kerja divisi),
 * "S1"/"S2" = shift ke-1/ke-2 (divisi 2 shift, mis. Cetak & Oven).
 * Data tetap disimpan di ShiftSchedule (1 baris = masuk pada shift tertentu), jadi absensi, rekap telat, dan Alpa
 * otomatis tetap memakai data yang sama.
 */
export type Cell = "" | "IN" | "S1" | "S2";
export const CELLS: Cell[] = ["", "IN", "S1", "S2"];
export type SchedRow = { employeeId: string; shiftDiv: boolean };
export type Change = { employeeId: string; date: string; value: Cell };

export const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;

/** Nilai sel dari jadwal tersimpan: index shift aktif (urut kode) 0 → S1, 1 → S2 */
export function cellOf(shiftIndex: number | null, shiftDiv: boolean): Cell {
  if (shiftIndex == null || shiftIndex < 0) return "";
  if (!shiftDiv) return "IN";
  return shiftIndex >= 1 ? "S2" : "S1";
}

/** Semua karyawan di tanggal itu sudah masuk (tombol cepat berubah jadi "Kosongkan") */
export function allIn(draft: Record<string, Cell>, date: string, rows: SchedRow[]): boolean {
  return rows.length > 0 && rows.every((r) => (draft[cellKey(r.employeeId, date)] ?? "") !== "");
}

/**
 * Tombol cepat per tanggal: "Semua masuk" → divisi 1 shift dicentang; divisi 2 shift yang sudah S1/S2 dibiarkan,
 * yang masih "—" diisi S1. Bila semua sudah masuk → "Kosongkan": semua jadi "—".
 */
export function quickFill(draft: Record<string, Cell>, date: string, rows: SchedRow[]): Record<string, Cell> {
  const next = { ...draft };
  const clear = allIn(draft, date, rows);
  for (const r of rows) {
    const k = cellKey(r.employeeId, date);
    const cur = next[k] ?? "";
    next[k] = clear ? "" : r.shiftDiv ? (cur === "S1" || cur === "S2" ? cur : "S1") : "IN";
  }
  return next;
}

/** Daftar perubahan draf dibanding yang tersimpan (untuk disimpan sekaligus) */
export function diffCells(saved: Record<string, Cell>, draft: Record<string, Cell>): Change[] {
  const out: Change[] = [];
  for (const k of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
    const a = saved[k] ?? "";
    const b = draft[k] ?? "";
    if (a === b) continue;
    const [employeeId, date] = k.split("|");
    out.push({ employeeId, date, value: b });
  }
  return out.sort((x, y) => (x.employeeId + x.date).localeCompare(y.employeeId + y.date));
}

/** Validasi & normalisasi kiriman dari HP (dipakai server action) */
export function parseChanges(raw: unknown, maxItems = 2000): Change[] {
  if (!Array.isArray(raw)) throw new Error("Data jadwal tidak valid");
  if (raw.length > maxItems) throw new Error("Terlalu banyak perubahan sekaligus");
  return raw.map((c) => {
    const o = c as Partial<Change>;
    if (typeof o.employeeId !== "string" || !o.employeeId || typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !CELLS.includes(o.value as Cell)) throw new Error("Data jadwal tidak valid");
    return { employeeId: o.employeeId, date: o.date, value: o.value as Cell };
  });
}
