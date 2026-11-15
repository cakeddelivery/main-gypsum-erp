import sharp from "sharp";
import { prisma } from "./db";
import { saveProof } from "./storage";
import { sniffMime } from "./imageCompress";

export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/** URL foto profil (dengan versi agar cache HP diperbarui saat foto diganti); null = tampil inisial */
export function avatarUrl(u: { id: string; photoPath?: string | null; photoUpdatedAt?: Date | null }): string | null {
  return u.photoPath ? `/api/files/avatar/${u.id}?v=${u.photoUpdatedAt?.getTime() ?? 0}` : null;
}

/** Foto profil: diputar sesuai EXIF, dipotong persegi di tengah, 400 px, JPEG kecil tanpa metadata (EXIF/GPS) */
export async function profileJpeg(buf: Buffer): Promise<Buffer> {
  const mime = sniffMime(buf);
  if (!mime || !mime.startsWith("image/")) throw new Error("File foto harus berupa gambar (JPG, PNG, atau WEBP)");
  if (buf.length > MAX_AVATAR_BYTES) throw new Error("Ukuran foto maksimal 8 MB");
  return sharp(buf).rotate().resize(400, 400, { fit: "cover", position: "centre" }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
}

export async function setProfilePhoto(userId: string, buf: Buffer) {
  const jpg = await profileJpeg(buf);
  const rel = await saveProof(jpg, "image/jpeg");
  return prisma.user.update({ where: { id: userId }, data: { photoPath: rel, photoUpdatedAt: new Date() }, select: { id: true, photoPath: true, photoUpdatedAt: true } });
}

export async function clearProfilePhoto(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { photoPath: null, photoUpdatedAt: new Date() } });
}
