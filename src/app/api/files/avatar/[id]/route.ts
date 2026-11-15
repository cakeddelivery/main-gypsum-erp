import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { proofContentType, readProof } from "@/lib/storage";

/** Foto profil pengguna: hanya untuk yang sudah login (rekan kerja bisa melihat foto satu sama lain) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getUser())) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const u = await prisma.user.findUnique({ where: { id }, select: { photoPath: true } });
  if (!u?.photoPath) return new Response("Not found", { status: 404 });
  const buf = await readProof(u.photoPath);
  // URL berversi (?v=…): aman disimpan lama di HP
  return new Response(new Uint8Array(buf), { headers: { "content-type": proofContentType(buf, "image/jpeg"), "cache-control": "private, max-age=2592000, immutable" } });
}
