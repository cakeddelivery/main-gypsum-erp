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

/** Akhir sebuah nominal di teks: "60rb", "1,5jt", "= 40.000", "Rp 40.000", "40.000", "40000" */
const AMOUNT_END = /(\d+(?:[.,]\d+)?\s*(?:jt|juta|rb|ribu|k)\b|(?:rp\.?\s*|=\s*)\d[\d.]*|\b\d{1,3}(?:\.\d{3})+\b|\b\d{4,}\b)/gi;

/**
 * Pecah deskripsi campur jadi bagian-bagian: pemisah baris baru, ';', ',', ' / ', ' + ', ' & ', ' dan ', ' serta ';
 * lalu tiap potongan dipecah lagi setelah setiap nominalnya ("Kopi 60rb Kardus 5rb Beli LPG 3 tabung 60rb" → 3 bagian), agar nominal
 * baris LPG diambil dari bagian LPG-nya sendiri, bukan dari angka bagian lain.
 */
export function splitParts(text: string): { text: string; amount: number | null }[] {
  const out: { text: string; amount: number | null }[] = [];
  for (const rough of text.split(/\r?\n|;|,|\s\/\s|\s\+\s|\s&\s|\sdan\s|\sserta\s/i).map((x) => x.trim()).filter(Boolean)) {
    let last = 0;
    for (const m of rough.matchAll(AMOUNT_END)) {
      const end = (m.index ?? 0) + m[0].length;
      const part = rough.slice(last, end).trim();
      if (part) out.push({ text: part, amount: parseRupiah(part) });
      last = end;
    }
    const rest = rough.slice(last).trim();
    if (rest) out.push({ text: rest, amount: null });
  }
  return out;
}

/**
 * Bagian LPG dari satu transaksi bernominal `total` berdasarkan deskripsinya:
 *  - satu bagian saja / semua bagian LPG → penuh
 *  - bagian LPG bernominal → jumlah nominal bagian LPG itu saja (≤ total)
 *  - bagian LPG tanpa nominal sendiri → tidak-terparse (perlu cek manual; tidak ditebak dari total − bagian lain)
 */
export function lpgShare(text: string | null | undefined, total: number, opt: { hargaTabung?: number } = {}): LpgShare {
  const s = (text ?? "").trim();
  if (!isLpgText(s)) return { mode: "tidak-lpg" };
  const parts = splitParts(s);
  const lpg = parts.filter((x) => isLpgText(x.text));
  if (parts.length <= 1 || lpg.length === parts.length) return { mode: "penuh", amount: total };
  const lines = lpg.map((x) => x.text);
  if (lpg.every((x) => x.amount != null)) return { mode: "baris", amount: Math.min(total, lpg.reduce((a, x) => a + (x.amount ?? 0), 0)), lines };
  // Opsi eksplisit --harga-tabung: bagian LPG tanpa nominal tetapi menyebut jumlah tabung → jumlah × harga (hanya bila SEMUA bagian LPG menyebut jumlah tabung)
  if (opt.hargaTabung && opt.hargaTabung > 0 && lpg.every((x) => x.amount == null && /(\d+)\s*(?:tabung|tbg)/i.test(x.text))) {
    const n = lpg.reduce((a, x) => a + Number(/(\d+)\s*(?:tabung|tbg)/i.exec(x.text)![1]), 0);
    return { mode: "baris", amount: Math.min(total, n * opt.hargaTabung), lines };
  }
  return { mode: "tidak-terparse", lines };
}

/**
 * Teks analisis dari beberapa kolom transaksi (catatan, teks mentah, pihak): nilai kosong dibuang, dan nilai yang sudah termuat di nilai lain
 * (mis. catatan sama dengan teks mentah) tidak diulang, supaya satu baris LPG tidak terhitung dua kali ("3 tabung" + "3 tabung" = 6). Dipisah baris baru.
 */
export function analysisText(values: (string | null | undefined)[]): string {
  const vs = [...new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))];
  return vs.filter((v, i) => !vs.some((o, j) => j !== i && (o.length > v.length || (o.length === v.length && j < i)) && o.toLowerCase().includes(v.toLowerCase()))).join("\n");
}
