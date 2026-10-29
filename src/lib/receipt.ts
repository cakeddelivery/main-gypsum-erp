import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractAccount } from "./extract";

const MODEL = process.env.RECEIPT_MODEL || process.env.ADVISOR_MODEL || "claude-opus-5-5";

export type ReceiptRead = {
  amount: number | null;
  date: string | null;
  direction: "MASUK" | "KELUAR" | null;
  account: string | null;
  counterparty: string | null;
};

// Tanpa nilai null agar kompatibel penuh dengan structured outputs: 0 / "" / TIDAK_JELAS = tidak terbaca
const SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean" },
    amount: { type: "integer" },
    date: { type: "string" },
    direction: { type: "string", enum: ["MASUK", "KELUAR", "TIDAK_JELAS"] },
    account: { type: "string" },
    counterparty: { type: "string" },
  },
  required: ["is_receipt", "amount", "date", "direction", "account", "counterparty"],
  additionalProperties: false,
};

export function receiptReaderConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Baca nominal, tanggal, arah & rekening dari foto bukti transfer/nota. Null bila gagal atau bukan bukti transaksi. */
export async function readReceipt(image: Buffer, caption: string, accounts: ExtractAccount[]): Promise<ReceiptRead | null> {
  if (!receiptReaderConfigured()) return null;
  const ours = accounts.map((a) => `${a.name} (${a.code})`).join(", ");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } },
          {
            type: "text",
            text: `Foto ini dikirim admin usaha "Main Gypsum" sebagai bukti transaksi. Rekening milik usaha: ${ours}.
Keterangan dari admin: "${caption || "-"}"
Baca dari foto: amount = nominal transaksi dalam rupiah (bilangan bulat, tanpa biaya admin bila terpisah; 0 bila tidak terbaca), date = tanggal transaksi (YYYY-MM-DD, kosong bila tidak terlihat), account = nama rekening usaha yang terlibat persis seperti daftar di atas (kosong bila tidak terlihat), counterparty = nama pihak lain (penerima/pengirim/toko, kosong bila tidak ada).
direction: KELUAR bila uang keluar dari rekening usaha (transfer ke pihak lain, nota belanja), MASUK bila uang masuk ke rekening usaha. Isi TIDAK_JELAS bila ragu.
is_receipt = false bila foto bukan bukti transaksi/nota. Jangan menebak angka yang tidak terbaca.`,
          },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let out: { is_receipt: boolean; amount: number; date: string; direction: string; account: string; counterparty: string };
  try {
    out = JSON.parse(text);
  } catch {
    return null;
  }
  if (!out.is_receipt) return null;
  return {
    amount: typeof out.amount === "number" && out.amount > 0 ? Math.round(out.amount) : null,
    date: typeof out.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? out.date : null,
    direction: out.direction === "MASUK" || out.direction === "KELUAR" ? out.direction : null,
    account: out.account || null,
    counterparty: out.counterparty || null,
  };
}
