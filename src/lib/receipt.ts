import "server-only";
import { aiConfigured, aiText, modelFor, parseJsonObject } from "./ai";
import type { ExtractAccount } from "./extract";

export type ReceiptRead = {
  amount: number | null;
  date: string | null;
  direction: "MASUK" | "KELUAR" | null;
  account: string | null;
  counterparty: string | null;
};

export function receiptReaderConfigured() {
  return aiConfigured();
}

/** Baca nominal, tanggal, arah & rekening dari foto bukti transfer/nota. Null bila gagal atau bukan bukti transaksi. */
export async function readReceipt(image: Buffer, caption: string, accounts: ExtractAccount[]): Promise<ReceiptRead | null> {
  if (!receiptReaderConfigured()) return null;
  const ours = accounts.map((a) => `${a.name} (${a.code})`).join(", ");
  const text = await aiText({
    model: modelFor("RECEIPT_MODEL"),
    maxTokens: 4000,
    effort: "low",
    image: { data: image, mime: "image/jpeg" },
    text: `Foto ini dikirim admin usaha "Main Gypsum" sebagai bukti transaksi. Rekening milik usaha: ${ours}.
Keterangan dari admin: "${caption || "-"}"
Balas HANYA satu objek JSON tanpa teks lain, dengan kunci:
{"is_receipt": boolean, "amount": integer, "date": "YYYY-MM-DD", "direction": "MASUK"|"KELUAR"|"TIDAK_JELAS", "account": string, "counterparty": string}
amount = nominal transaksi dalam rupiah (bilangan bulat, tanpa biaya admin bila terpisah; 0 bila tidak terbaca). date = tanggal transaksi ("" bila tidak terlihat). account = nama rekening usaha yang terlibat persis seperti daftar di atas ("" bila tidak terlihat). counterparty = nama pihak lain: penerima/pengirim/toko ("" bila tidak ada).
direction: KELUAR bila uang keluar dari rekening usaha (transfer ke pihak lain, nota belanja), MASUK bila uang masuk ke rekening usaha, TIDAK_JELAS bila ragu.
is_receipt = false bila foto bukan bukti transaksi/nota. Jangan menebak angka yang tidak terbaca.`,
  });
  const out = parseJsonObject<{ is_receipt?: boolean; amount?: unknown; date?: unknown; direction?: unknown; account?: unknown; counterparty?: unknown }>(text);
  if (!out || !out.is_receipt) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const amount = typeof out.amount === "number" ? out.amount : typeof out.amount === "string" ? Number(out.amount.replace(/[^\d]/g, "")) : 0;
  const date = str(out.date);
  return {
    amount: amount > 0 ? Math.round(amount) : null,
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    direction: out.direction === "MASUK" || out.direction === "KELUAR" ? out.direction : null,
    account: str(out.account),
    counterparty: str(out.counterparty),
  };
}
