import "server-only";
import { aiConfigured, aiText, modelFor, parseJsonObject } from "./ai";
import type { ExtractAccount } from "./extract";

export type ReceiptRead = {
  amount: number | null;
  date: string | null;
  direction: "MASUK" | "KELUAR" | "TRANSFER" | null;
  account: string | null;
  toAccount: string | null;
  counterparty: string | null;
};

export function receiptReaderConfigured() {
  return aiConfigured();
}

/** Baca nominal, tanggal, arah & rekening dari foto bukti transfer/nota. Null bila gagal atau bukan bukti transaksi. */
export async function readReceipt(image: Buffer, caption: string, accounts: ExtractAccount[], mime = "image/jpeg"): Promise<ReceiptRead | null> {
  if (!receiptReaderConfigured()) return null;
  const ours = accounts.map((a) => `${a.name} (${a.code})`).join(", ");
  const text = await aiText({
    model: modelFor("RECEIPT_MODEL"),
    maxTokens: 4000,
    effort: "low",
    image: { data: image, mime },
    text: `Foto ini dikirim admin usaha "Main Gypsum" sebagai bukti transaksi. Rekening milik usaha: ${ours}.
Keterangan dari admin: "${caption || "-"}"
Balas HANYA satu objek JSON tanpa teks lain, dengan kunci:
{"is_receipt": boolean, "amount": integer, "date": "YYYY-MM-DD", "direction": "MASUK"|"KELUAR"|"TRANSFER"|"TIDAK_JELAS", "account": string, "to_account": string, "counterparty": string}
amount = nominal transaksi dalam rupiah (bilangan bulat, tanpa biaya admin bila terpisah; 0 bila tidak terbaca). date = tanggal transaksi ("" bila tidak terlihat). account = nama rekening usaha yang terlibat (untuk TRANSFER: rekening asal), ditulis persis seperti daftar di atas ("" bila tidak terlihat). to_account = rekening usaha tujuan, hanya untuk TRANSFER ("" selain itu). counterparty = nama pihak lain: penerima/pengirim/toko ("" bila tidak ada).
direction: TRANSFER bila uang hanya berpindah antar rekening milik usaha (mis. penarikan/withdraw Saldo Penjual Shopee ke Seabank, top up ShopeePay dari Seabank); rekening bank atas nama pemilik usaha dianggap rekening usaha. KELUAR bila uang keluar ke pihak lain (bayar supplier, nota belanja). MASUK bila uang masuk dari pihak lain. TIDAK_JELAS bila ragu.
is_receipt = false bila foto bukan bukti transaksi/nota. Jangan menebak angka yang tidak terbaca.`,
  });
  const out = parseJsonObject<{ is_receipt?: boolean; amount?: unknown; date?: unknown; direction?: unknown; account?: unknown; to_account?: unknown; counterparty?: unknown }>(text);
  if (!out || !out.is_receipt) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const amount = typeof out.amount === "number" ? out.amount : typeof out.amount === "string" ? Number(out.amount.replace(/[^\d]/g, "")) : 0;
  const date = str(out.date);
  return {
    amount: amount > 0 ? Math.round(amount) : null,
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    direction: out.direction === "MASUK" || out.direction === "KELUAR" || out.direction === "TRANSFER" ? out.direction : null,
    account: str(out.account),
    toAccount: out.direction === "TRANSFER" ? str(out.to_account) : null,
    counterparty: str(out.counterparty),
  };
}
