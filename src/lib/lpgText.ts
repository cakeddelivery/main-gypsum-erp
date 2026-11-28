/**
 * Mengenali pembelian LPG yang dicatat sebagai transaksi Finance biasa (kategori mis. "Pembelian Bahan Baku" / "Konsumsi") dari teksnya,
 * dan mengambil nominal baris LPG bila deskripsinya campur (mis. "Beli LPG 3 tabung 60rb, kopi 15rb, angkut 20rb").
 */
export const LPG_TEXT = /\b(lpg|elpiji)\b/i;
export const isLpgText = (s: string | null | undefined) => LPG_TEXT.test(s ?? "");

/** "60rb", "60 ribu", "60k", "1,5jt", "Rp 40.000", "= 40.000", "40000" → rupiah; null bila tidak ada nominal yang jelas */
export function parseRupiah(line: string): number | null {
  const t = line.toLowerCase();
  let m = /(\d+(?:[.,]\d+)?)\s*(?:jt|juta)\b/.exec(t);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * 1_000_000);
  m = /(\d+(?:[.,]\d+)?)\s*(?:rb|ribu|k)\b/.exec(t);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000);
  m = /(?:rp\.?\s*|=\s*)(\d[\d.]*)/.exec(t);
  if (m) { const n = Number(m[1].replace(/\./g, "")); if (n >= 1000) return n; }
  m = /\b(\d{1,3}(?:\.\d{3})+)\b/.exec(t);
  if (m) return Number(m[1].replace(/\./g, ""));
  m = /\b(\d{4,})\b/.exec(t);
  return m ? Number(m[1]) : null;
}

export type LpgShare =
  | { mode: "tidak-lpg" }
  | { mode: "penuh"; amount: number }
  | { mode: "baris"; amount: number; lines: string[] }
  | { mode: "tidak-terparse"; lines: string[] };

/** Bagian LPG dari satu transaksi bernominal `total` berdasarkan deskripsinya (baris dipisah baris baru, ';', ',' atau ' + ') */
export function lpgShare(text: string | null | undefined, total: number): LpgShare {
  const s = (text ?? "").trim();
  if (!isLpgText(s)) return { mode: "tidak-lpg" };
  const lines = s.split(/\r?\n|;|,|\s\+\s/).map((x) => x.trim()).filter(Boolean);
  const lpg = lines.filter(isLpgText);
  if (lines.length <= 1 || lpg.length === lines.length) return { mode: "penuh", amount: total };
  const parsed = lpg.map(parseRupiah);
  if (parsed.some((x) => x == null)) return { mode: "tidak-terparse", lines: lpg };
  const amount = Math.min(total, parsed.reduce<number>((a, b) => a + (b ?? 0), 0));
  return { mode: "baris", amount, lines: lpg };
}
