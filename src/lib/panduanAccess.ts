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

/** Gambar layar asli yang tersedia di public/panduan/shots (nama → URL dengan versi) */
export function guideShots(): Record<string, string> {
  const dir = path.join(process.cwd(), "public", "panduan", "shots");
  try {
    return Object.fromEntries(
      fs.readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => [f.replace(/\.png$/, ""), `/panduan/shots/${f}?v=${Math.round(fs.statSync(path.join(dir, f)).mtimeMs)}`]),
    );
  } catch {
    return {};
  }
}
