/**
 * Ambil nominal dari teks hasil OCR bukti transfer (tanpa AI).
 * Prioritas: angka pada baris berkata kunci (Total/Nominal/Jumlah/Transfer) → angka setelah "Rp" yang paling sering muncul → terbesar.
 */
const KEYWORD = /\b(total|nominal|jumlah|amount|trans[fi]er|dibayar|pembayaran)\b/i;
const IGNORE = /\b(biaya|admin|fee|saldo|sisa|limit)\b/i;
// OCR sering salah baca "Rp" jadi "Ap", "Hp", "Kp", atau "RP"
const RP_NUM = /\b[RrAHK]\s*[pP]\.?\s*:?\s*([0-9]{1,3}(?:[.,\s][0-9]{3})+(?:[.,][0-9]{2})?|[0-9]+)(?![0-9])/g;
const BARE_NUM = /(?<![\d.,])([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?|[0-9]{4,})(?![\d.,])/g;

/** "1.580.000" / "1,580,000.00" / "1.580.000,00" / "1 580 000" → 1580000 */
export function parseRupiah(raw: string): number | null {
  // Buang desimal sen di akhir (",00" / ".00")
  const s = raw.replace(/\s+/g, "").replace(/[.,]\d{2}$/, "");
  const digits = s.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 && n < 10_000_000_000 ? n : null;
}

export function amountFromOcrText(text: string): number | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyword: number[] = [];
  const rp: number[] = [];
  lines.forEach((line, i) => {
    const found = [...line.matchAll(RP_NUM)].map((m) => parseRupiah(m[1])).filter((n): n is number => !!n);
    rp.push(...(IGNORE.test(line) ? [] : found));
    if (KEYWORD.test(line) && !IGNORE.test(line)) {
      // Angka bisa di baris yang sama atau baris berikutnya ("Total" ↵ "Rp1.580.000")
      const same = found.length ? found : [...line.matchAll(BARE_NUM)].map((m) => parseRupiah(m[1])).filter((n): n is number => !!n);
      const next = lines[i + 1] ? [...lines[i + 1].matchAll(RP_NUM)].map((m) => parseRupiah(m[1])).filter((n): n is number => !!n) : [];
      keyword.push(...(same.length ? same : next));
    }
  });
  const pick = (xs: number[]) => {
    if (!xs.length) return null;
    const count = new Map<number, number>();
    for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  };
  // Cadangan: angka berformat ribuan (1.580.000) tanpa "Rp", ambil yang terbesar
  const bare = lines.filter((l) => !IGNORE.test(l) && !/\d{1,2}[:/]\d{2}/.test(l)).flatMap((l) => [...l.matchAll(BARE_NUM)].map((m) => m[1]).filter((x) => /[.,]\d{3}/.test(x)).map(parseRupiah)).filter((n): n is number => !!n);
  return pick(keyword) ?? pick(rp) ?? (bare.length ? Math.max(...bare) : null);
}

/** Rekening usaha yang namanya muncul di teks (mis. "SeaBank") */
export function bankFromOcrText(text: string, banks: { id: string; name: string }[]) {
  const t = text.toLowerCase().replace(/\s+/g, "");
  return banks.find((b) => t.includes(b.name.toLowerCase().replace(/\s+/g, "")))?.id ?? null;
}
