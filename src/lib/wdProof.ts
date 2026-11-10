import { extractDate, extractTime } from "./extract";
import { amountFromOcrText, parseRupiah } from "./ocrAmount";

/**
 * Bukti "Uang diterima" withdraw TikTok: screenshot uang masuk di aplikasi bank, atau Seller Center TikTok yang
 * menunjukkan dana sudah ditransfer. Dari teksnya (OCR di browser/server, atau AI) dibaca nominal, tanggal & jam.
 * Modul ini tanpa database/Node agar bisa dipakai di browser (form web) maupun server (bot & validasi server).
 */
/** source: "seller" = Seller Center TikTok (tanggal = ditransfer, uang masuk bank 1–3 hari kemudian), "bank" = mutasi bank */
/** "seller_done" = Seller Center "Detail penarikan dana" dengan tahap "Berhasil ditransfer" (= uang sudah masuk bank pada jam itu) */
export type WdProofRead = { amounts: number[]; amount: number | null; date: string | null; time: string | null; source?: "bank" | "seller" | "seller_done" | null; ref?: string | null; last4?: string | null };

/**
 * Screenshot TikTok Seller Center "Detail penarikan dana". Contoh:
 *   Jumlah penarikan dana Rp649.690 · Rekening bank ********5984 · No. Referensi 378129218802204 7837
 *   Berhasil ditransfer 10/11/2026 07:34 · Sedang diproses · Pengajuan 09/11/2026 20:58
 * Keputusan owner (10 Nov): "Pengajuan" = tanggal transfer (jurnal 1, penjualan diakui), "Berhasil ditransfer" =
 * uang sudah masuk SeaBank pada jam itu (jurnal 2). Tanpa "Berhasil ditransfer" = masih Dalam Proses.
 */
export type SellerWithdrawal = { amount: number | null; last4: string | null; ref: string | null; submitted: { date: string; time: string | null } | null; transferred: { date: string; time: string | null } | null };

const stamp = (lines: string[], re: RegExp, now: Date) => {
  const k = lines.findIndex((l) => re.test(l));
  if (k < 0) return null;
  // Tanggal di baris yang sama, atau 1–2 baris sesudah/sebelum label (tata letak OCR berbeda-beda)
  for (const j of [k, k + 1, k + 2, k - 1]) {
    const l = lines[j];
    if (!l || (j !== k && /(berhasil|pengajuan|diproses|ditransfer)/i.test(l))) continue;
    const d = extractDate(l.replace(/\b(hari ini|kemarin)\b/gi, ""), now);
    if (d && +d.slice(0, 4) >= 2020 && +d.slice(0, 4) <= 2100) return { date: d, time: extractTime(l) ?? (lines[j + 1] && !/(berhasil|pengajuan|diproses)/i.test(lines[j + 1]) ? extractTime(lines[j + 1]) : null) };
  }
  return null;
};

/** Baca "Detail penarikan dana" Seller Center. Null bila teksnya bukan detail penarikan TikTok. */
export function parseSellerWithdrawal(text: string, now: Date = new Date()): SellerWithdrawal | null {
  if (!/penarikan dana|pengajuan|berhasil ditransfer|sedang diproses/i.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const submitted = stamp(lines, /\bpengajuan\b/i, now);
  const transferred = stamp(lines, /berhasil\s*ditransfer/i, now);
  if (!submitted && !transferred) return null;
  const amtLine = lines.findIndex((l) => /jumlah\s*penarikan/i.test(l));
  const near = amtLine >= 0 ? [lines[amtLine], lines[amtLine + 1] ?? ""].join("\n") : "";
  const amount = (near && amountsInText(near)[0]) || amountFromOcrText(text);
  const acct = text.match(/rekening[^\n]*?(?:\*|x|•|\.){2,}\s*(\d{4})\b/i) ?? text.match(/(?:\*|x|•){3,}\s*(\d{4})\b/i);
  const refLine = lines.findIndex((l) => /no\.?\s*referensi|reference/i.test(l));
  const refText = refLine >= 0 ? `${lines[refLine].replace(/.*(?:referensi|reference)\s*:?/i, "")} ${/^[\d\s]+$/.test(lines[refLine + 1] ?? "") ? lines[refLine + 1] : ""}` : "";
  const refDigits = refText.replace(/\D/g, "");
  return { amount: amount || null, last4: acct?.[1] ?? null, ref: refDigits.length >= 8 ? refDigits : null, submitted, transferred };
}

/** Hasil baca untuk validasi "Uang diterima" dari detail penarikan Seller Center */
export function sellerProofRead(w: SellerWithdrawal): WdProofRead {
  const at = w.transferred ?? w.submitted;
  return { amounts: w.amount ? [w.amount] : [], amount: w.amount, date: at?.date ?? null, time: at?.time ?? null, source: w.transferred ? "seller_done" : "seller", ref: w.ref, last4: w.last4 };
}

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
  const w = parseSellerWithdrawal(text, now);
  if (w) return { ...sellerProofRead(w), amounts: [...new Set([...(w.amount ? [w.amount] : []), ...amountsInText(text)])] };
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
    ref: a?.ref ?? b?.ref ?? null,
    last4: a?.last4 ?? b?.last4 ?? null,
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
