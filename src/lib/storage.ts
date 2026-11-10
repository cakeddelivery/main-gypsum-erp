import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compressImage } from "./imageCompress";

export { proofContentType } from "./imageCompress";

const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
/** Batas unggah SEBELUM kompres. Gambar lalu diperkecil (biasanya jadi < 500 KB), PDF disimpan apa adanya. */
export const MAX_PROOF_MB = 15;
export const MAX_PROOF_BYTES = MAX_PROOF_MB * 1024 * 1024;
export const MAX_PROOF_TEXT = `Ukuran bukti maksimal ${MAX_PROOF_MB} MB`;

function root() {
  return path.resolve(process.env.STORAGE_DIR || "./storage/private");
}

/**
 * Simpan bukti di penyimpanan privat (di luar folder public). Mengembalikan path relatif.
 * Gambar dikompres dulu (lihat imageCompress.ts): diputar sesuai EXIF, maks 1600/2000 px, JPEG, tanpa EXIF/GPS.
 * Ekstensi file mengikuti isi yang disimpan (gambar terkompres = .jpg). Content-type saat dibaca selalu dari isi file.
 */
export async function saveProof(buf: Buffer, mime: string): Promise<string> {
  const ext0 = ALLOWED[mime];
  if (!ext0) throw new Error("Format bukti harus JPG, PNG, WEBP, atau PDF");
  if (buf.length > MAX_PROOF_BYTES) throw new Error(MAX_PROOF_TEXT);
  // Validasi magic bytes agar tidak bisa menyamarkan file lain
  const sig = buf.subarray(0, 4).toString("hex");
  const okSig = (ext0 === "jpg" && sig.startsWith("ffd8")) || (ext0 === "png" && sig === "89504e47") || (ext0 === "pdf" && sig === "25504446") || (ext0 === "webp" && buf.subarray(8, 12).toString() === "WEBP");
  if (!okSig) throw new Error("Isi file tidak sesuai formatnya");
  let data = buf;
  let ext = ext0;
  if (ext0 !== "pdf") {
    const c = await compressImage(buf);
    if (c.changed) {
      data = c.buf;
      ext = "jpg";
    }
  }
  const d = new Date();
  const rel = path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), `${crypto.randomUUID()}.${ext}`);
  const full = path.join(root(), rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, { mode: 0o600 });
  return rel;
}

export async function readProof(rel: string): Promise<Buffer> {
  const full = path.resolve(root(), rel);
  if (!full.startsWith(root() + path.sep)) throw new Error("Path tidak valid");
  return fs.readFile(full);
}
