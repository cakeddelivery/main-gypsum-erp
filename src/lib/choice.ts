/**
 * Aturan kolom pilihan di semua form (permintaan owner 30/10/2026):
 * ≤ 3 opsi → tombol pilihan (segmented), > 3 opsi → dropdown yang bisa dicari.
 */
export const MAX_BUTTON_OPTIONS = 3;

export type ChoiceMode = "buttons" | "search";

export function choiceMode(optionCount: number): ChoiceMode {
  return optionCount <= MAX_BUTTON_OPTIONS ? "buttons" : "search";
}

/** Cocokkan teks pencarian: semua kata harus ada (urutan bebas, tanpa beda huruf besar/kecil) */
export function matchesQuery(label: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const l = label.toLowerCase();
  return words.every((w) => l.includes(w));
}

/**
 * Huruf pertama tiap kata dijadikan kapital (permintaan owner: semua isian diawali huruf kapital).
 * Huruf lain dibiarkan apa adanya supaya singkatan seperti "CV", "UD", "ml" tidak rusak.
 */
export function capitalizeWords(text: string) {
  return text.replace(/(^|[\s(/-])(\p{Ll})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase("id-ID"));
}

/** Kolom isian yang tidak dikapitalkan: login, kode, email/URL, angka */
const SKIP_NAMES = /^(username|password|newPassword|confirm|sku|code|aliases|keywords|email|url|token|chatId|telegram.*)$/i;
export function shouldCapitalize(el: { tagName: string; type?: string; name?: string; inputMode?: string; autocomplete?: string; readOnly?: boolean; dataset?: Record<string, string | undefined> }) {
  if (el.readOnly || el.dataset?.raw !== undefined) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && !["text", ""].includes(el.type ?? "text")) return false;
  if (tag !== "input" && tag !== "textarea") return false;
  if (["numeric", "decimal", "email", "url", "tel"].includes(el.inputMode ?? "")) return false;
  if (/user|pass|one-time/.test(el.autocomplete ?? "")) return false;
  return !SKIP_NAMES.test(el.name ?? "");
}
