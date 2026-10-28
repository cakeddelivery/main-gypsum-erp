import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

function root() {
  return path.resolve(process.env.STORAGE_DIR || "./storage/private");
}

/** Simpan bukti di penyimpanan privat (di luar folder public). Mengembalikan path relatif. */
export async function saveProof(buf: Buffer, mime: string): Promise<string> {
  const ext = ALLOWED[mime];
  if (!ext) throw new Error("Format bukti harus JPG, PNG, WEBP, atau PDF");
  if (buf.length > MAX_PROOF_BYTES) throw new Error("Ukuran bukti maksimal 5 MB");
  // Validasi magic bytes agar tidak bisa menyamarkan file lain
  const sig = buf.subarray(0, 4).toString("hex");
  const okSig = (ext === "jpg" && sig.startsWith("ffd8")) || (ext === "png" && sig === "89504e47") || (ext === "pdf" && sig === "25504446") || (ext === "webp" && buf.subarray(8, 12).toString() === "WEBP");
  if (!okSig) throw new Error("Isi file tidak sesuai formatnya");
  const d = new Date();
  const rel = path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), `${crypto.randomUUID()}.${ext}`);
  const full = path.join(root(), rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { mode: 0o600 });
  return rel;
}

export async function readProof(rel: string): Promise<Buffer> {
  const full = path.resolve(root(), rel);
  if (!full.startsWith(root() + path.sep)) throw new Error("Path tidak valid");
  return fs.readFile(full);
}
