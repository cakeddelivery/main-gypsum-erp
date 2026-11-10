import { promises as fs } from "node:fs";
import path from "node:path";
import { alreadyCompressed, compressImage, sniffMime } from "./imageCompress";

/** Hasil kompres baru dipakai bila hemat minimal 10%, supaya file tidak dikompres ulang berkali-kali */
export const MIN_SAVING = 0.1;
const TMP = ".kompres-tmp";

export type FileResult = { rel: string; before: number; after: number; status: "dikompres" | "metadata dibuang" | "sudah kecil" | "sudah diproses" | "tidak lebih kecil" | "bukan gambar" | "gagal" };
export type StorageReport = { files: FileResult[]; total: number; before: number; after: number; changed: number };

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && !e.name.endsWith(TMP)) yield full;
  }
}

/**
 * Kompres semua foto lama di folder bukti. `run=false` = hanya hitung perkiraan (tidak menulis apa pun).
 * Path & nama file TIDAK berubah (tautan di database tetap valid); isi .png/.webp bisa menjadi JPEG,
 * dan route /api/files menentukan content-type dari isi file. Tulis aman: file sementara lalu rename.
 */
export async function compressStorage(dir: string, opts: { run: boolean; onFile?: (r: FileResult) => void }): Promise<StorageReport> {
  const files: FileResult[] = [];
  for await (const full of walk(dir)) {
    const rel = path.relative(dir, full);
    const st = await fs.stat(full);
    const r: FileResult = { rel, before: st.size, after: st.size, status: "bukan gambar" };
    try {
      const buf = await fs.readFile(full);
      const mime = sniffMime(buf);
      if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") r.status = "bukan gambar";
      else if (alreadyCompressed(buf)) r.status = "sudah diproses";
      else {
        const c = await compressImage(buf, { minSaving: MIN_SAVING });
        if (!c.changed) r.status = c.reason === "sudah kecil" ? "sudah kecil" : c.reason === "tidak lebih kecil" ? "tidak lebih kecil" : c.reason === "bukan gambar" ? "bukan gambar" : "gagal";
        else {
          r.after = c.buf.length;
          r.status = c.reason === "metadata dibuang" ? "metadata dibuang" : "dikompres";
          if (opts.run) {
            const tmp = full + TMP;
            await fs.writeFile(tmp, c.buf, { mode: st.mode & 0o777 });
            await fs.utimes(tmp, st.atime, st.mtime);
            await fs.rename(tmp, full);
          }
        }
      }
    } catch {
      r.status = "gagal";
      r.after = r.before;
      await fs.rm(full + TMP, { force: true }).catch(() => {});
    }
    files.push(r);
    opts.onFile?.(r);
  }
  return {
    files,
    total: files.length,
    before: files.reduce((s, f) => s + f.before, 0),
    after: files.reduce((s, f) => s + f.after, 0),
    changed: files.filter((f) => f.status === "dikompres" || f.status === "metadata dibuang").length,
  };
}

export function fmtBytes(n: number) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  return Math.round(n / 1024) + " KB";
}
