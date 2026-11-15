import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { serveMedia } from "@/lib/mediaServe";

/**
 * Media retur (video, thumbnail, potongan gambar, foto kerusakan) bersifat privat. Video dialirkan dengan HTTP Range
 * (206) sehingga hanya bagian yang diputar yang diunduh; daftar retur hanya memuat thumbnail.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !(user.can("retur.manage") || user.can("accounting.view"))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const m = await prisma.returnMedia.findUnique({ where: { id } });
  if (!m?.storageKey || m.status === "DELETED" || m.status === "UPLOADING") return new Response("Not found", { status: 404 });
  return serveMedia(req, m.storageKey, m.mime);
}
