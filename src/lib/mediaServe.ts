import { Readable } from "node:stream";
import { mediaStore } from "./mediaStore";

/** Kirim file media privat; mendukung HTTP Range (206) agar video bisa diputar & digeser tanpa mengunduh semuanya */
export async function serveMedia(req: Request, key: string, mime: string | null) {
  const size = await mediaStore.size(key);
  if (!size) return new Response("Not found", { status: 404 });
  const base = { "content-type": mime ?? "application/octet-stream", "cache-control": "private, max-age=3600", "accept-ranges": "bytes", "content-disposition": "inline", "x-content-type-options": "nosniff" };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    // Satu respons maks ±2 MB agar pemutaran mulai cepat di HP
    end = Math.min(end, start + 2 * 1024 * 1024 - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    start = Math.max(0, start);
    return new Response(Readable.toWeb(mediaStore.stream(key, { start, end })) as ReadableStream, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  return new Response(Readable.toWeb(mediaStore.stream(key)) as ReadableStream, { headers: { ...base, "content-length": String(size) } });
}
