/** Bagian LPG yang aman dipakai di komponen klien (tanpa akses database) */
export type LpgInput = { penuh: number; aktif: number; kosong: number; isiUlang: number };

/**
 * Aliran tabung antar dua laporan: P' = P − dipasang + isiUlang, A' = A + dipasang − habis, K' = K + habis − isiUlang.
 * dipasang (penuh → aktif) dan habis (aktif → kosong) diturunkan; angka tidak masuk akal (minus) ditandai.
 */
export function lpgFlow(prev: { penuh: number; aktif: number; kosong: number } | null, cur: LpgInput): { dipasang: number; habis: number; valid: boolean } {
  if (!prev) return { dipasang: 0, habis: 0, valid: true };
  const dipasang = prev.penuh - cur.penuh + cur.isiUlang;
  const habis = prev.aktif + dipasang - cur.aktif;
  return { dipasang, habis, valid: dipasang >= 0 && habis >= 0 };
}
