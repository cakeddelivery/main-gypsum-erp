import { extractDate, extractTime, interestKind, type ExtractAccount } from "./extract";
import { amountFromOcrText } from "./ocrAmount";

/** Hasil baca foto bukti dari teks OCR (bentuknya sama dengan hasil AI di receipt.ts) */
export type OcrReceipt = {
  amount: number | null;
  date: string | null;
  time?: string | null;
  direction: "MASUK" | "KELUAR" | "TRANSFER" | null;
  account: string | null;
  toAccount: string | null;
  counterparty: string | null;
};

const DATE_LINE = /\b(waktu|tanggal|tgl|date|time|dibuat)\b/i;
const COUNTERPARTY = /^(?:ke|kepada|penerima|nama penerima|tujuan|merchant|nama merchant|toko|dibayar ke)\b\s*:?\s*(.+)$/i;
const SENDER = /^(?:dari|pengirim|sumber dana|rekening sumber)\b/i;
const INCOMING = /\b(dana masuk|uang masuk|diterima|terima dana|menerima|transfer masuk)\b/i;
const OUTGOING = /\b(qris|pembayaran|bayar|transfer berhasil|berhasil|bukti transaksi|bukti transfer|struk|nota|total|dibayar)\b/i;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Nama rekening usaha (name/alias ≥4 huruf) yang muncul di teks; dicocokkan tanpa spasi/tanda baca agar tahan salah baca OCR */
function accountIn(text: string, accounts: ExtractAccount[]): string | null {
  const t = squash(text);
  const hits: { name: string; start: number; end: number }[] = [];
  for (const a of accounts) {
    for (const k of [a.name, ...a.aliases.split(",")].map(squash).filter((k) => k.length >= 4)) {
      for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) hits.push({ name: a.name, start: i, end: i + k.length });
    }
  }
  // Kunci yang terpotong kunci lain yang lebih panjang ke kanan bukan kecocokan: "saldoshopee|pay" = ShopeePay,
  // bukan Saldo Penjual Shopee
  const ok = hits.filter((h) => !hits.some((o) => o !== h && o.start > h.start && o.start < h.end && o.end > h.end));
  return ok.sort((a, b) => b.end - b.start - (a.end - a.start))[0]?.name ?? null;
}

/** Bersihkan sisa ikon/logo yang terbaca OCR di depan nama ("@ sumberjaya", "© Toko A") */
function cleanName(s: string) {
  return s.replace(/^(?:[^A-Za-z0-9]+|[A-Za-z0-9](?=\s))+\s*/, "").replace(/\s{2,}/g, " ").trim();
}

export function receiptFromOcrText(text: string, accounts: ExtractAccount[], now: Date = new Date()): OcrReceipt | null {
  const amount = amountFromOcrText(text);
  if (!amount) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Tanggal: baris berlabel waktu/tanggal dulu, lalu baris mana pun yang memuat tanggal
  let date: string | null = null;
  let time: string | null = null;
  for (const l of [...lines.filter((l) => DATE_LINE.test(l)), ...lines.filter((l) => !DATE_LINE.test(l) && !/\bno\b/i.test(l))]) {
    const d = extractDate(l, now);
    if (d && +d.slice(0, 4) >= 2020 && +d.slice(0, 4) <= 2100) {
      date = d;
      time = extractTime(l);
      break;
    }
  }
  // Jam sering di baris tersendiri ("14:32 WIB") di bawah/atas tanggal
  if (!time) for (const l of lines.filter((l) => !/\b(no|ref|id)\b/i.test(l))) if ((time = extractTime(l))) break;

  let counterparty: string | null = null;
  for (const l of lines) {
    const m = l.match(COUNTERPARTY);
    if (m) {
      const name = cleanName(m[1]);
      if (name.length >= 3) {
        counterparty = name.slice(0, 120);
        break;
      }
    }
  }

  // Rekening usaha: utamakan yang tertulis di blok "Dari", lalu di mana pun (mis. logo "SeaBank" di atas)
  const senderIdx = lines.findIndex((l) => SENDER.test(l));
  const senderBlock = senderIdx >= 0 ? lines.slice(senderIdx, senderIdx + 3).join(" ") : "";
  const account = (senderBlock && accountIn(senderBlock, accounts)) || accountIn(text, accounts);

  // Arah: kebanyakan foto yang dikirim adalah bukti bayar; MASUK hanya bila jelas tertulis
  // Resi bunga tabungan ("Bunga Rp 218") = uang masuk; pajak bunga = keluar
  const ik = interestKind(text);
  const direction = ik === "BUNGA" ? "MASUK" : ik === "PAJAK" ? "KELUAR" : INCOMING.test(text) ? "MASUK" : OUTGOING.test(text) || senderIdx >= 0 ? "KELUAR" : null;

  return { amount, date, time, direction, account, toAccount: null, counterparty };
}
