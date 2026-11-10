import sharp from "sharp";

/**
 * Kompres foto bukti agar hemat disk: putar sesuai EXIF, perkecil (tidak pernah memperbesar),
 * simpan sebagai JPEG (mozjpeg) dan buang metadata EXIF/GPS. PDF & format lain tidak diubah.
 *
 * Kenapa JPEG (bukan WebP): JPEG terbaca di semua tempat yang memakai bukti — Chromium (render.ts / kop JPG),
 * Tesseract OCR, AI receipt, Telegram, dan saat diunduh/dibuka di HP/PC lama.
 *
 * Screenshot (PNG) biasanya berisi teks kecil (bukti transfer, mutasi), jadi diberi batas lebih longgar
 * agar tetap terbaca OCR: sisi terpanjang 2000 px, kualitas 82. Foto kamera (JPG/WEBP): 1600 px, kualitas 75.
 */
export const PHOTO = { maxSide: 1600, quality: 75 } as const;
export const SCREENSHOT = { maxSide: 2000, quality: 82 } as const;

export type ImageKind = "jpeg" | "png" | "webp";

/** Tebak jenis file dari isinya (magic bytes), bukan dari nama/ekstensi */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  return null;
}

/** Content-type untuk dikirim ke browser: dari isi file; cadangan dari data tersimpan */
export function proofContentType(buf: Buffer, stored?: string | null): string {
  return sniffMime(buf) ?? stored ?? "application/octet-stream";
}

/**
 * Gambar di bawah ukuran ini yang tidak perlu diperkecil/diputar TIDAK di-encode ulang: hematnya kecil, sedangkan
 * encode ulang foto beresolusi rendah (mis. foto dari Telegram) bisa membuat OCR gagal membaca jam/angka kecil.
 * Untuk JPEG, EXIF/GPS tetap dibuang tanpa mengubah piksel.
 */
export const SMALL_BYTES = 150 * 1024;
/** Penanda (segmen komentar JPEG) bahwa file sudah diproses, supaya skrip kompres aman diulang */
const MARK = Buffer.from("MG-KOMPRES/1");

function addMark(jpeg: Buffer): Buffer {
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xfffe, 0);
  seg.writeUInt16BE(MARK.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, MARK, jpeg.subarray(2)]);
}

export type CompressReason = "dikompres" | "metadata dibuang" | "sudah kecil" | "tidak lebih kecil" | "bukan gambar" | "gambar tidak bisa dibaca";
export type CompressResult = { buf: Buffer; mime: string; changed: boolean; reason: CompressReason };

/**
 * Buang segmen APP1 (EXIF termasuk GPS, XMP) dan APP13 (IPTC) dari JPEG tanpa encode ulang (piksel sama persis).
 * Mengembalikan null bila struktur JPEG tidak dikenali.
 */
export function stripJpegMetadata(buf: Buffer): Buffer | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // byte pengisi
      continue;
    }
    if (marker === 0xda) {
      parts.push(buf.subarray(i)); // mulai data gambar (SOS) sampai akhir: disalin apa adanya
      return Buffer.concat(parts);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker !== 0xe1 && marker !== 0xed) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

/** True bila file sudah pernah diproses (ada penanda dari compressImage) */
export function alreadyCompressed(buf: Buffer): boolean {
  return sniffMime(buf) === "image/jpeg" && buf.subarray(0, 64).includes(MARK);
}

/**
 * Kompres satu gambar. Bila bukan gambar, gagal dibaca, atau hasilnya tidak lebih kecil, isi asli dikembalikan apa adanya.
 * `minSaving` = penghematan minimal (0..1) agar hasil encode ulang dipakai; mencegah kompres ulang yang hanya menurunkan mutu.
 */
export async function compressImage(buf: Buffer, opts: { minSaving?: number } = {}): Promise<CompressResult> {
  const mime = sniffMime(buf);
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return { buf, mime: mime ?? "application/octet-stream", changed: false, reason: "bukan gambar" };
  try {
    const cfg = mime === "image/png" ? SCREENSHOT : PHOTO;
    const m = await sharp(buf).metadata();
    const side = Math.max(m.width ?? 0, m.height ?? 0);
    const upright = !m.orientation || m.orientation === 1;
    if (upright && side <= cfg.maxSide && buf.length < SMALL_BYTES) {
      if (mime === "image/jpeg" && (m.exif || m.xmp || m.iptc)) {
        const s = stripJpegMetadata(buf);
        if (s && s.length < buf.length) return { buf: addMark(s), mime, changed: true, reason: "metadata dibuang" };
      } else return { buf, mime, changed: false, reason: "sudah kecil" };
    }
    const raw = await sharp(buf, { failOn: "none" })
      .rotate() // putar sesuai EXIF Orientation
      .resize({ width: cfg.maxSide, height: cfg.maxSide, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // PNG transparan → latar putih (JPEG tidak punya transparansi)
      .jpeg({ quality: cfg.quality, mozjpeg: true, chromaSubsampling: mime === "image/png" ? "4:4:4" : "4:2:0" })
      .toBuffer(); // tanpa withMetadata(): EXIF/GPS/ICC dibuang
    const out = addMark(raw);
    const need = 1 - (opts.minSaving ?? 0);
    if (out.length >= buf.length * need) {
      // Tetap simpan aslinya, tapi EXIF/GPS JPEG tegak tetap dibuang (tanpa encode ulang)
      const s = upright && mime === "image/jpeg" && (m.exif || m.xmp || m.iptc) ? stripJpegMetadata(buf) : null;
      if (s && s.length < buf.length) return { buf: addMark(s), mime, changed: true, reason: "metadata dibuang" };
      return { buf, mime, changed: false, reason: "tidak lebih kecil" };
    }
    return { buf: out, mime: "image/jpeg", changed: true, reason: "dikompres" };
  } catch {
    return { buf, mime, changed: false, reason: "gambar tidak bisa dibaca" };
  }
}
