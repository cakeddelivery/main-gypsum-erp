import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptFromOcrText } from "@/lib/ocrReceiptText";
import { extractTransaction, mergeReceipt } from "@/lib/extract";

const accounts = [
  { id: "sb", code: "SEABANK", name: "Seabank", aliases: "sea bank" },
  { id: "sp", code: "SHOPEEPAY", name: "ShopeePay", aliases: "" },
];
const cats = [{ id: "ops", name: "Operasional", direction: "KELUAR" as const, keywords: "lpg,gas,isi ulang" }];

// Teks OCR asli dari bukti QRIS SeaBank (dikirim lewat bot Telegram)
const SEABANK_QRIS = `© seaBank
‘Bukti Transaksi

Dari © Nur Anjola Hidayat Diharjo Putra
8 Sessanic eeersoes

Ke @ sumberjaya
Kab. Lamongan

Nama Acquirer Dana
936009153061.7187:864

Nominal Transaksi Rp 40.000
Biaya Transaksi GRATIS
Juriah Total Rp 40.000
No. Transaksi 2026110343500474168631305
No. Referensi 011000MNQSGD
Terminal ID 061718786
Metode Transaksi QRIS
Waktu Transaksi 03 Nov 2026, 08:52`;

describe("baca bukti transaksi dari teks OCR", () => {
  it("QRIS SeaBank: nominal, tanggal, rekening, tujuan", () => {
    const r = receiptFromOcrText(SEABANK_QRIS, accounts, new Date("2026-11-03T04:00:00Z"));
    expect(r).toEqual({ amount: 40000, date: "2026-11-03", time: "08:52", direction: "KELUAR", account: "Seabank", toAccount: null, counterparty: "sumberjaya" });
  });
  it("digabung dengan caption menjadi draft lengkap", () => {
    const text = "Isi ulang tabung LPG 2 pcs";
    const ex = extractTransaction(text, accounts, cats, new Date("2026-11-03T04:00:00Z"));
    expect(ex.amount).toBeNull();
    const e = mergeReceipt(ex, text, receiptFromOcrText(SEABANK_QRIS, accounts), accounts, cats);
    expect(e).toMatchObject({ amount: 40000, date: "2026-11-03", direction: "KELUAR", accountId: "sb", categoryId: "ops", missing: [] });
    expect(e.note).toBe("Isi ulang tabung LPG 2 pcs (sumberjaya)");
  });
  it("tanpa nominal → null; uang masuk dikenali", () => {
    expect(receiptFromOcrText("Halo apa kabar", accounts)).toBeNull();
    expect(receiptFromOcrText("Dana Masuk\nRp 150.000\n12/10/2026", accounts)?.direction).toBe("MASUK");
  });
  it("OCR server membaca foto asli", async () => {
    const { ocrReceipt } = await import("@/lib/ocrReceipt");
    const r = await ocrReceipt(readFileSync(join(__dirname, "fixtures", "bukti-seabank-qris.jpg")), accounts);
    expect(r).toMatchObject({ amount: 40000, date: "2026-11-03", direction: "KELUAR", account: "Seabank" });
  }, 60_000);
});
