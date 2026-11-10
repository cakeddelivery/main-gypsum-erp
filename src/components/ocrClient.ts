"use client";
/** Perkecil foto HP (sisi terpanjang 1600 px, JPEG) agar cepat diunggah & dibaca (sama dengan form pembelian) */
export async function shrinkImage(f: File): Promise<File> {
  if (!f.type.startsWith("image/")) return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], "bukti.jpg", { type: "image/jpeg" }) : f;
  } catch {
    return f;
  }
}

/** Baca teks foto langsung di browser (Tesseract, mesin & data bahasa dari public/ocr). Gagal → null */
export async function ocrInBrowser(f: File): Promise<string | null> {
  if (!f.type.startsWith("image/")) return null;
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, { workerPath: "/ocr/worker.min.js", corePath: "/ocr", langPath: "/ocr" });
    try {
      const { data } = await worker.recognize(f);
      return data.text;
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    console.warn("OCR gagal", e);
    return null;
  }
}
