import { extractDate, extractTime } from "./extract";
import { amountFromOcrText, parseRupiah } from "./ocrAmount";

/**
 * Bukti "Uang diterima" withdraw TikTok: screenshot uang masuk di aplikasi bank, atau Seller Center TikTok yang
 * menunjukkan dana sudah ditransfer. Dari teksnya (OCR di browser/server, atau AI) dibaca nominal, tanggal & jam.
 * Modul ini tanpa database/Node agar bisa dipakai di browser (form web) maupun server (bot & validasi server).
 */
/** source: "seller" = Seller Center TikTok (tanggal = ditransfer, uang masuk bank 1–3 hari kemudian), "bank" = mutasi bank */
export type WdProofRead = { amounts: number[]; amount: number | null; date: string | null; time: string | null; source?: "bank" | "seller" | null };

export const SELLER_NOTE = "Bukti dari Seller Center TikTok: uang biasanya masuk bank 1–3 hari setelah tanggal ini. Pastikan tanggal & jam terima sesuai mutasi bank.";

/** Jenis bukti dari teksnya */
export function proofSource(text: string): "bank" | "seller" | null {
  if (/ditransfer ke bank|seller ?cent(er|re)|riwayat penarikan|penarikan dana|tarik saldo|withdraw/i.test(text)) return "seller";
  if (/uang masuk|dana masuk|transfer masuk|mutasi|kredit|seabank|diterima dari/i.test(text)) return "bank";
  return null;
}

const RP = /\b[RrAHK]\s*[pP]\.?\s*:?\s*([0-9]{1,3}(?:[.,\s][0-9]{3})+(?:[.,][0-9]{2})?|[0-9]{4,})(?![0-9])/g;
const THOUSANDS = /(?<![\d.,])([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?)(?![\d.,])/g;
const DATE_LINE = /\b(waktu|tanggal|tgl|date|time|ditransfer|diterima|dana masuk|selesai|berhasil)\b/i;

/** Semua nominal rupiah yang tertulis di bukti (dengan "Rp" atau berformat ribuan) */
export function amountsInText(text: string): number[] {
  const out = new Set<number>();
  for (const l of text.split(/\r?\n/)) {
    if (/\d{1,2}[:/]\d{2}/.test(l) && !/rp/i.test(l)) continue; // baris tanggal/jam
    for (const m of l.matchAll(RP)) { const n = parseRupiah(m[1]); if (n && n >= 1000) out.add(n); }
    for (const m of l.matchAll(THOUSANDS)) { const n = parseRupiah(m[1]); if (n && n >= 1000) out.add(n); }
  }
  return [...out];
}

/** Baca nominal, tanggal (YYYY-MM-DD) & jam (HH:MM) dari teks bukti */
export function readWdProofText(text: string, now: Date = new Date()): WdProofRead {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let date: string | null = null;
  let time: string | null = null;
  // Baris berlabel tanggal/ditransfer dulu, lalu baris mana pun (lewati nomor referensi)
  for (const l of [...lines.filter((l) => DATE_LINE.test(l)), ...lines.filter((l) => !DATE_LINE.test(l) && !/\b(no|ref|id)\b/i.test(l))]) {
    const d = extractDate(l.replace(/\b(hari ini|kemarin)\b/gi, ""), now);
    if (d && +d.slice(0, 4) >= 2020 && +d.slice(0, 4) <= 2100) {
      date = d;
      time = extractTime(l);
      // Jam sering di baris berikutnya
      if (!time) { const k = lines.indexOf(l); time = (lines[k + 1] && extractTime(lines[k + 1])) || null; }
      break;
    }
  }
  if (date && !time) for (const l of lines.filter((l) => !/\b(no|ref|id)\b/i.test(l))) if ((time = extractTime(l))) break;
  return { amounts: amountsInText(text), amount: amountFromOcrText(text), date, time, source: proofSource(text) };
}

/** Gabungkan dua hasil baca (mis. OCR + AI): nominal digabung, tanggal/jam diambil yang ada */
export function mergeWdProof(a: WdProofRead | null, b: WdProofRead | null): WdProofRead {
  return {
    amounts: [...new Set([...(a?.amounts ?? []), ...(b?.amounts ?? []), ...[a?.amount, b?.amount].filter((x): x is number => !!x)])],
    amount: a?.amount ?? b?.amount ?? null,
    date: a?.date ?? b?.date ?? null,
    time: (a?.date ? a?.time : null) ?? b?.time ?? a?.time ?? null,
    source: a?.source ?? b?.source ?? null,
  };
}

export type WdProofCheck = { amountOk: boolean; dateOk: boolean; ok: boolean; issues: string[] };

/** Validasi bukti terhadap nominal withdraw: nominal harus tertulis di bukti, tanggal harus terbaca */
export function checkWdProof(read: WdProofRead | null, amount: number): WdProofCheck {
  const rp = (n: number) => "Rp" + n.toLocaleString("id-ID");
  const amountOk = !!read && (read.amounts.includes(amount) || read.amount === amount);
  const dateOk = !!read?.date;
  const issues: string[] = [];
  if (!amountOk) issues.push(read?.amount ? `nominal di bukti ${rp(read.amount)}, bukan ${rp(amount)}` : `nominal ${rp(amount)} tidak terbaca di bukti`);
  if (!dateOk) issues.push("tanggal tidak terbaca di bukti");
  return { amountOk, dateOk, ok: amountOk && dateOk, issues };
}
