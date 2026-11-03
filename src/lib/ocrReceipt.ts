import "server-only";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "tesseract.js";
import type { ExtractAccount } from "./extract";
import { receiptFromOcrText, type OcrReceipt } from "./ocrReceiptText";

/**
 * Baca foto bukti transaksi di server dengan Tesseract (tanpa AI, tanpa kuota).
 * Dipakai bot Telegram bila AI tidak terpasang, kuotanya habis, atau tidak menemukan nominal.
 * Mesin OCR menyala saat pertama dipakai lalu dimatikan setelah 3 menit menganggur.
 */
let worker: Promise<Worker> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;

function langPath() {
  // public/ocr disalin saat build (scripts/copy-ocr.mjs); cadangan langsung dari node_modules
  const pub = join(process.cwd(), "public", "ocr");
  if (existsSync(join(pub, "eng.traineddata.gz"))) return pub;
  return join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
}

async function getWorker() {
  if (!worker) {
    worker = import("tesseract.js").then(({ createWorker }) => createWorker("eng", 1, { langPath: langPath(), cachePath: join(tmpdir(), "mg-ocr-cache"), gzip: true }));
    worker.catch(() => (worker = null));
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    const w = worker;
    worker = null;
    w?.then((x) => x.terminate()).catch(() => {});
  }, 180_000);
  idle.unref?.();
  return worker;
}

export async function ocrImageText(image: Buffer): Promise<string> {
  const w = await getWorker();
  const r = await w.recognize(image);
  return r.data.text ?? "";
}

/** Null bila foto tidak berisi nominal yang terbaca */
export async function ocrReceipt(image: Buffer, accounts: ExtractAccount[]): Promise<OcrReceipt | null> {
  const text = await ocrImageText(image);
  return receiptFromOcrText(text, accounts);
}
