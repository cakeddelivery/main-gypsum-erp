import { spawn, spawnSync } from "node:child_process";
import { prisma } from "./db";
import { mediaStore } from "./mediaStore";

/**
 * Pemrosesan video unboxing di server:
 * - Bila ffmpeg terpasang di VPS: dikompres ke MP4 H.264 maks 720p (CRF 30, bitrate dibatasi ±700 kbps, audio AAC 64 kbps,
 *   faststart agar bisa diputar sambil diunduh) → ±5–10 MB per 2–3 menit. File mentah dihapus. Thumbnail dibuat bila belum ada.
 * - Bila ffmpeg tidak ada: video mentah dari HP (bitrate sudah rendah) dipakai apa adanya.
 * Satu video diproses dalam satu waktu (threads 1) agar VPS tetap ringan.
 */
let ffmpegOk: boolean | null = null;
export function ffmpegAvailable() {
  if (ffmpegOk === null) {
    try {
      ffmpegOk = spawnSync("ffmpeg", ["-version"], { timeout: 5000 }).status === 0;
    } catch {
      ffmpegOk = false;
    }
  }
  return ffmpegOk;
}

function run(args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + String(d)).slice(-2000)));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg gagal (${code}): ${err.split("\n").filter(Boolean).slice(-2).join(" ")}`)); });
  });
}

let queue: Promise<unknown> = Promise.resolve();
/** Masukkan video ke antrean proses (tidak ditunggu oleh permintaan unggah) */
export function enqueueVideo(mediaId: string) {
  queue = queue.then(() => processVideo(mediaId)).catch((e) => console.error("proses video", mediaId, e));
  return queue;
}

export async function processVideo(mediaId: string) {
  const m = await prisma.returnMedia.findUnique({ where: { id: mediaId } });
  if (!m || m.kind !== "VIDEO" || m.status !== "PROCESSING" || !m.storageKey) return m;
  if (!ffmpegAvailable()) {
    return prisma.returnMedia.update({ where: { id: m.id }, data: { status: "READY", size: await mediaStore.size(m.storageKey), error: null } });
  }
  const src = m.storageKey;
  const outKey = src.replace(/\.[a-z0-9]+$/i, "") + ".720.mp4";
  try {
    await run([
      "-y", "-hide_banner", "-loglevel", "error", "-i", mediaStore.localPath(src),
      "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "700k", "-bufsize", "1400k", "-pix_fmt", "yuv420p", "-threads", "1",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", mediaStore.localPath(outKey),
    ], 20 * 60_000);
    const size = await mediaStore.size(outKey);
    if (!size) throw new Error("hasil kompres kosong");
    const hasThumb = await prisma.returnMedia.count({ where: { returnId: m.returnId, kind: "THUMB", status: "READY" } });
    if (!hasThumb) {
      const thumbKey = mediaStore.newKey("retur", "jpg");
      try {
        await run(["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", mediaStore.localPath(outKey), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", mediaStore.localPath(thumbKey)], 60_000);
        await prisma.returnMedia.create({ data: { returnId: m.returnId, kind: "THUMB", status: "READY", storageKey: thumbKey, mime: "image/jpeg", size: await mediaStore.size(thumbKey), createdBy: "Sistem" } });
      } catch {
        /* thumbnail opsional */
      }
    }
    await mediaStore.remove(src);
    return prisma.returnMedia.update({ where: { id: m.id }, data: { status: "READY", storageKey: outKey, mime: "video/mp4", size, error: null, meta: { ...((m.meta as object) ?? {}), compressed: true, rawSize: m.received } } });
  } catch (e) {
    await mediaStore.remove(outKey).catch(() => {});
    // Video mentah tetap bisa diputar: tandai siap, catat galat kompres
    return prisma.returnMedia.update({ where: { id: m.id }, data: { status: "READY", size: await mediaStore.size(src), error: `Kompres gagal: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) } });
  }
}
