/**
 * Cocokkan nama karyawan dari pesan bebas ("gaji rico okt", "bayaran Mas Bagus", "upah dewi kartka").
 * Dipakai bot Telegram untuk bayar slip gaji. Toleran: nama panggilan, sebagian nama, dan salah ketik ringan.
 */
export type EmpLite = { id: string; name: string; nickname?: string | null };
export type MatchResult<T extends EmpLite> = { sure: T | null; similar: T[] };

const STOP = new Set([
  "gaji", "gajian", "upah", "bayar", "bayaran", "slip", "transfer", "tf", "periode", "bulan", "minggu", "untuk", "buat", "ke", "dan", "atas", "nama",
  "mas", "mbak", "mba", "pak", "bu", "bang", "kak", "dik", "sdr", "sdri", "bpk", "ibu", "karyawan", "pekerja", "lunas", "sisa", "dari", "via", "rek", "rekening",
  "jan", "januari", "feb", "februari", "mar", "maret", "apr", "april", "mei", "jun", "juni", "jul", "juli", "agu", "agustus", "agt", "sep", "september", "okt", "oktober", "nov", "november", "des", "desember",
  "rp", "rb", "ribu", "jt", "juta", "k", "bca", "bri", "bni", "mandiri", "seabank", "dana", "ovo", "gopay", "shopeepay", "cash", "tunai",
]);

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const nameTokens = (text: string) => norm(text).split(" ").filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w));

/** Jarak edit (Levenshtein) */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Kemiripan satu kata pesan dengan satu kata nama: 1 = sama, 0.85 = awalan, ~0.7–0.85 = salah ketik ringan */
export function wordScore(token: string, word: string): number {
  if (!token || !word || word.length < 3) return 0;
  if (token === word) return 1;
  if (token.length >= 3 && word.startsWith(token)) return 0.85; // "ric" → "rico"
  if (word.length >= 4 && token.startsWith(word)) return 0.8; // "ricoo" → "rico"
  if (token.length >= 4 && word.length >= 4) {
    const d = editDistance(token, word);
    const allowed = Math.max(token.length, word.length) >= 7 ? 2 : 1;
    if (d <= allowed) return 0.85 - 0.1 * d;
  }
  return 0;
}

/** Skor karyawan: kata nama/panggilan paling cocok, + bonus bila dua kata nama sama-sama disebut */
export function employeeScore(tokens: string[], e: EmpLite): number {
  const words = [...new Set([...(e.nickname ? norm(e.nickname).split(" ") : []), ...norm(e.name).split(" ")])].filter((w) => w.length >= 3);
  const best = words.map((w) => Math.max(0, ...tokens.map((t) => wordScore(t, w))));
  const sorted = best.sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  return top + (second >= 0.75 ? 0.5 : 0);
}

export const SURE = 1; // minimal satu kata nama/panggilan sama persis
const SIMILAR = 0.6;

/**
 * Tepat satu karyawan dengan skor tertinggi yang yakin (≥ SURE dan jelas di atas yang lain) → `sure`.
 * Selain itu `similar` berisi karyawan yang mirip (urut skor), bisa kosong bila tidak ada yang mirip.
 */
export function matchEmployees<T extends EmpLite>(text: string, emps: T[]): MatchResult<T> {
  const tokens = nameTokens(text);
  if (!tokens.length) return { sure: null, similar: [] };
  const scored = emps.map((e) => ({ e, s: employeeScore(tokens, e) })).filter((x) => x.s >= SIMILAR).sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name, "id"));
  const [a, b] = scored;
  if (a && a.s >= SURE && (!b || a.s - b.s >= 0.5)) return { sure: a.e, similar: [] };
  return { sure: null, similar: scored.slice(0, 8).map((x) => x.e) };
}
