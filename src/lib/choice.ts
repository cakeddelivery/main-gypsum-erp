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
