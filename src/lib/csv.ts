/** Isi sel CSV: angka tetap angka (tanpa pemisah ribuan) agar bisa dijumlah di Excel; teks diberi kutip bila perlu. */
export type Cell = string | number | null | undefined;

export function csvCell(v: Cell, sep = ";"): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v).replace(".", ",") : "";
  const s = String(v);
  // Cegah formula injection saat dibuka di Excel/Sheets
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return safe.includes(sep) || safe.includes('"') || /[\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV dengan pemisah titik koma (default Excel berbahasa Indonesia) + BOM UTF-8 */
export function toCsv(rows: Cell[][], sep = ";"): string {
  return "﻿" + rows.map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join("\r\n") + "\r\n";
}
