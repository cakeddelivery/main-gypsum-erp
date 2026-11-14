import { Readable } from "node:stream";
import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mediaStore } from "@/lib/mediaStore";

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
  const size = await mediaStore.size(m.storageKey);
  if (!size) return new Response("Not found", { status: 404 });
  const type = m.mime ?? "application/octet-stream";
  const base = { "content-type": type, "cache-control": "private, max-age=3600", "accept-ranges": "bytes", "content-disposition": "inline" };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1]) end = size - 1;
    // Batasi satu respons ±2 MB agar pemutaran mulai cepat di HP
    end = Math.min(end, start + 2 * 1024 * 1024 - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    start = Math.max(0, start);
    const body = Readable.toWeb(mediaStore.stream(m.storageKey, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  const body = Readable.toWeb(mediaStore.stream(m.storageKey)) as ReadableStream;
  return new Response(body, { headers: { ...base, "content-length": String(size) } });
}
