/** Rapikan email isian (huruf kecil). Kosong → null. Format salah → error. */
export function normEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new EmailError("Format email tidak valid");
  return v;
}

export class EmailError extends Error {}
