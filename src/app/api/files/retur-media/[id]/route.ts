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
  const res = await serveMedia(req, m.storageKey, m.mime);
  // ?unduh=1 → unduh sebagai berkas (video unboxing untuk bukti klaim)
  if (new URL(req.url).searchParams.get("unduh") === "1" && m.kind === "VIDEO") {
    const r = await prisma.returnCase.findUnique({ where: { id: m.returnId }, select: { number: true, trackingNo: true } });
    const ext = m.mime === "video/mp4" ? "mp4" : m.mime === "video/quicktime" ? "mov" : "webm";
    const name = `${r?.number ?? "retur"}-${(r?.trackingNo ?? "video").replace(/[^A-Za-z0-9_-]/g, "")}.${ext}`;
    const headers = new Headers(res.headers);
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}
