import { prisma } from "./db";
import { ocrImageText } from "./ocrReceipt";
import { readReceipt, receiptReaderConfigured } from "./receipt";
import { checkWdProof, mergeWdProof, readWdProofText, type WdProofRead } from "./wdProof";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Baca bukti "Uang diterima" di server: OCR (gambar) dulu; bila nominal/tanggal belum cocok dan AI terpasang,
 * AI membaca foto/PDF sebagai cadangan. `ocrText` = teks OCR dari browser (form web) agar tidak dibaca dua kali.
 */
export async function readWdProofFile(buf: Buffer, mime: string, amount: number, ocrText?: string | null): Promise<WdProofRead | null> {
  let read: WdProofRead | null = ocrText?.trim() ? readWdProofText(ocrText) : null;
  if (!checkWdProof(read, amount).ok && mime.startsWith("image/")) {
    const text = await withTimeout(ocrImageText(buf).catch(() => ""), 25_000);
    if (text) read = mergeWdProof(read, readWdProofText(text));
  }
  if (!checkWdProof(read, amount).ok && receiptReaderConfigured()) {
    const banks = await prisma.bankAccount.findMany({ where: { active: true } });
    const ai = await withTimeout(readReceipt(buf, "bukti uang masuk ke rekening / riwayat penarikan Seller Center (ditransfer ke bank)", banks, mime).catch(() => null), 35_000);
    if (ai) read = mergeWdProof(read, { amounts: ai.amount ? [ai.amount] : [], amount: ai.amount, date: ai.date, time: ai.time ?? null });
  }
  return read;
}
