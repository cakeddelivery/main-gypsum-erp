import "server-only";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { memberDivision } from "./reportScope";
import { allowedGuides, isGuideId, type GuideId } from "./panduan";
import type { requireUser } from "./auth";

type User = Awaited<ReturnType<typeof requireUser>>;

/** Panduan yang boleh dibuka user ini (anggota: hanya divisinya dari data Karyawan) */
export async function guidesFor(user: User): Promise<{ allowed: GuideId[]; own: GuideId | null }> {
  const divId = memberDivision(user);
  const div = divId ? await prisma.division.findUnique({ where: { id: divId }, select: { reportTemplate: true } }) : null;
  const allowed = allowedGuides(user.role, div?.reportTemplate);
  const own = allowedGuides("OPERATOR", div?.reportTemplate)[0] ?? null;
  return { allowed, own };
}

/** Pilih panduan dari ?g=…: hanya yang diizinkan; selain itu panduan pertama yang boleh */
export function pickGuide(q: string | undefined, allowed: GuideId[], own: GuideId | null): GuideId | null {
  if (isGuideId(q) && allowed.includes(q)) return q;
  if (own && allowed.includes(own)) return own;
  return allowed[0] ?? null;
}

/** Folder gambar layar asli panduan (ikut repo, di dalam public/) */
export const SHOTS_DIR = path.join(process.cwd(), "public", "panduan", "shots");

let shotCache: { key: string; map: Record<string, string> } | null = null;

/**
 * Gambar layar asli panduan (nama → data URI). Ditanam langsung di halaman, bukan dirujuk lewat URL file,
 * agar selalu tampil di halaman Panduan dan ikut ke Unduh JPG/PDF tanpa bergantung pada penyajian file statis
 * (Nginx/Cloudflare/cache/izin login) atau gambar yang belum selesai dimuat saat lembar digambar.
 */
export function guideShots(): Record<string, string> {
  try {
    const files = fs.readdirSync(SHOTS_DIR).filter((f) => f.endsWith(".png")).sort();
    const key = files.map((f) => `${f}:${fs.statSync(path.join(SHOTS_DIR, f)).mtimeMs}`).join("|");
    if (shotCache?.key === key) return shotCache.map;
    const map = Object.fromEntries(files.map((f) => [f.replace(/\.png$/, ""), `data:image/png;base64,${fs.readFileSync(path.join(SHOTS_DIR, f)).toString("base64")}`]));
    shotCache = { key, map };
    return map;
  } catch (e) {
    console.error("Gambar layar panduan tidak terbaca:", SHOTS_DIR, e);
    return {};
  }
}
