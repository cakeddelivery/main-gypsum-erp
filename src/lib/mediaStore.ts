import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Readable } from "node:stream";

/**
 * Lapisan penyimpanan media besar (video retur, thumbnail, potongan gambar). Fitur hanya memakai fungsi di sini
 * dengan "kunci" (bukan path), jadi nanti bisa diganti driver R2/Google Drive tanpa mengubah fitur.
 * Driver sekarang: folder lokal VPS (MEDIA_DIR, bawaan STORAGE_DIR/media), file mode 0600, di luar folder public.
 */
export interface MediaStore {
  readonly driver: string;
  newKey(prefix: string, ext: string): string;
  size(key: string): Promise<number>;
  /** Tambah potongan di akhir file; ditolak bila ukuran file sekarang ≠ offset (unggah bertahap tetap urut) */
  append(key: string, chunk: Buffer, offset: number): Promise<number>;
  write(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  stream(key: string, range?: { start: number; end: number }): Readable;
  remove(key: string): Promise<void>;
  /** Path lokal untuk diproses ffmpeg (driver awan: unduh ke file sementara dulu) */
  localPath(key: string): string;
}

export function mediaRoot() {
  return path.resolve(process.env.MEDIA_DIR || path.join(process.env.STORAGE_DIR || "./storage/private", "media"));
}

class LocalStore implements MediaStore {
  readonly driver = "local";
  private full(key: string) {
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes("..")) throw new Error("Kunci media tidak valid");
    const root = mediaRoot();
    const f = path.resolve(root, key);
    if (!f.startsWith(root + path.sep)) throw new Error("Kunci media tidak valid");
    return f;
  }
  newKey(prefix: string, ext: string) {
    const d = new Date();
    return `${prefix}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  }
  async size(key: string) {
    try {
      return (await fs.stat(this.full(key))).size;
    } catch {
      return 0;
    }
  }
  async append(key: string, chunk: Buffer, offset: number) {
    const f = this.full(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    const cur = await this.size(key);
    if (cur !== offset) throw new MediaOffsetError(cur);
    await fs.appendFile(f, chunk, { mode: 0o600 });
    return cur + chunk.length;
  }
  async write(key: string, data: Buffer) {
    const f = this.full(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data, { mode: 0o600 });
  }
  read(key: string) {
    return fs.readFile(this.full(key));
  }
  stream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.full(key), range);
  }
  async remove(key: string) {
    await fs.rm(this.full(key), { force: true });
  }
  localPath(key: string) {
    return this.full(key);
  }
}

export class MediaOffsetError extends Error {
  constructor(public received: number) {
    super(`Posisi unggah tidak cocok (server sudah menerima ${received} byte)`);
  }
}

export const mediaStore: MediaStore = new LocalStore();

/** Sisa ruang disk tempat media disimpan */
export async function diskInfo(dir = mediaRoot()) {
  await fs.mkdir(dir, { recursive: true });
  const s = await fs.statfs(dir);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return { totalBytes: total, freeBytes: free, freePct: total > 0 ? Math.round((free / total) * 1000) / 10 : 100 };
}

export const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
