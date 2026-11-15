import "server-only";
import { aiConfigured, aiText, modelFor, parseJsonObject } from "./ai";
import { ocrImageText } from "./ocrReceipt";
import { compressImage } from "./imageCompress";
import { parseLabelText, sanitizeLabel, type LabelRead } from "./returnLabel";

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * Baca foto label resi di server: AI (KelontongAI/Claude) dulu, cadangan OCR tesseract bila AI tidak ada / kuota habis.
 * Foto TIDAK disimpan (hanya di memori selama dibaca). Hasil hanya berisi kolom yang boleh disimpan (sanitizeLabel):
 * nama, alamat jalan, dan no. HP pembeli tidak pernah ikut.
 */
export async function readReturnLabel(image: Buffer, mime: string): Promise<{ read: LabelRead; source: "AI" | "OCR" | "GAGAL"; error?: string }> {
  const img = await compressImage(image).then((c) => (c.changed ? { data: c.buf, mime: "image/jpeg" } : { data: image, mime })).catch(() => ({ data: image, mime }));
  let aiError = "";
  if (aiConfigured()) {
    try {
      const text = await withTimeout(aiText({
        model: modelFor("RECEIPT_MODEL"),
        maxTokens: 2000,
        effort: "low",
        image: img,
        accept: (t) => !!parseJsonObject<{ trackingNo?: string }>(t),
        text: `Foto ini label pengiriman paket RETUR marketplace Indonesia (Shopee / TikTok Shop / Tokopedia; kurir SPX, J&T, J&T Cargo/JTR, JNE, dll.).
Balas HANYA satu objek JSON tanpa teks lain:
{"marketplace": "SHOPEE"|"TIKTOK"|"LAINNYA", "courier": string, "trackingNo": string, "orderNo": string, "city": string, "province": string, "lines": [{"sku": string, "variation": string, "name": string, "qty": integer}]}
- trackingNo = nomor resi/AWB (biasanya di bawah barcode terbesar). orderNo = nomor pesanan marketplace.
- city = KOTA/KABUPATEN tujuan penerima saja (contoh "Kab. Lamongan" / "Kota Surabaya"), province = provinsi tujuan.
- lines = daftar produk di label: sku = SKU / Seller SKU (mis. "GIFT-MIX"), variation = variasi (mis. "STANDARD,MIX"), name = nama produk singkat, qty = jumlah.
- PENTING (data pribadi): JANGAN tulis nama orang, alamat jalan/RT/RW/kecamatan/kelurahan/kode pos, atau nomor HP siapa pun.
Isi "" bila tidak terbaca; jangan menebak.`,
      }), 45_000);
      const o = parseJsonObject<Record<string, unknown>>(text);
      if (o) {
        const read = sanitizeLabel(o);
        if (read.trackingNo || read.lines.length) return { read, source: "AI" };
      }
      aiError = "AI tidak bisa membaca label";
    } catch (e) {
      aiError = e instanceof Error ? e.message.slice(0, 120) : "AI gagal";
    }
  }
  try {
    const text = await withTimeout(ocrImageText(img.data), 30_000);
    const read = parseLabelText(text);
    return { read, source: "OCR", ...(aiError ? { error: aiError } : {}) };
  } catch (e) {
    return { read: sanitizeLabel(null), source: "GAGAL", error: `${aiError ? `${aiError}; ` : ""}OCR gagal: ${e instanceof Error ? e.message.slice(0, 80) : ""}` };
  }
}
