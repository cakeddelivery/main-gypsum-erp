/**
 * Saran produk untuk SKU marketplace yang belum dipetakan (murni, tanpa database): varian dari SKU / nama variasi / nama produk
 * (MIX, HEWAN, CEWEK, COWOK, TRANSPORTASI, ukuran paket 12/24, …) dicocokkan dengan produk ERP; produk di TOKO YANG BENAR naik ke atas.
 */
export type SuggestOption = { id: string; name: string; group: string; storeCode: string | null; words: string[] };
export type SuggestInput = { sku: string | null; variation: string | null; name: string | null; storeCodes: string[] };

const KEYWORDS = ["MIX", "HEWAN", "CEWEK", "COWOK", "TRANSPORTASI", "PAMA", "PALET", "MAGNET", "HALLOWEEN", "HWN", "CEW", "COW", "TRP"];
const ALIAS: Record<string, string> = { HWN: "HEWAN", CEW: "CEWEK", COW: "COWOK", TRP: "TRANSPORTASI" };
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter(Boolean).map((t) => ALIAS[t] ?? t);

/** Petunjuk dari satu teks: kata varian & angka ukuran paket */
function cues(text: string) {
  const t = tokens(text);
  return { words: new Set(t.filter((x) => KEYWORDS.includes(x) || ALIAS[x])), nums: new Set(t.filter((x) => /^\d{1,3}$/.test(x))) };
}

export function suggestProducts(input: SuggestInput, options: SuggestOption[], limit = 3): SuggestOption[] {
  const a = cues(`${input.sku ?? ""} ${input.variation ?? ""} ${input.name ?? ""}`);
  if (!a.words.size && !a.nums.size) return [];
  const scored = options.map((o) => {
    const b = cues(`${o.name} ${o.words.join(" ")}`);
    let score = 0;
    let wHit = 0, nHit = 0;
    for (const w of a.words) if (b.words.has(w)) { score += 3; wHit++; }
    for (const n of a.nums) if (b.nums.has(n)) { score += 4; nHit++; }
    // varian atau ukuran paket yang bertentangan (mis. MIX vs HEWAN, 24 vs 12) = bukan produk yang dimaksud
    if (a.words.size && b.words.size && !wHit) score -= 5;
    if (a.nums.size && b.nums.size && !nHit) score -= 5;
    const matched = score > 0;
    if (matched && o.storeCode && input.storeCodes.length) score += input.storeCodes.includes(o.storeCode) ? 5 : -1; // toko yang benar di atas
    return { o, score, matched };
  });
  return scored.filter((x) => x.matched && x.score > 0).sort((x, y) => y.score - x.score || x.o.name.localeCompare(y.o.name)).slice(0, limit).map((x) => x.o);
}

/** Kelompok produk induk dari nama (header grup di dropdown) bila keluarga produk tidak diketahui */
export function groupOf(name: string, family?: string | null): string {
  if (family) return family;
  if (/giftbox\s*custom|custom/i.test(name)) return "Giftbox Custom";
  const m = /paket\s*(\d+)/i.exec(name);
  if (m) return `Paket ${m[1]}`;
  if (/satuan|single/i.test(name)) return "Satuan / Single Pack";
  return name.split(/\s+/)[0] || "Lainnya";
}
