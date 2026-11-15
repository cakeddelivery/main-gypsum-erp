import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mediaStore, MediaOffsetError } from "@/lib/mediaStore";
import { enqueueVideo } from "@/lib/returnVideo";

/** Batas ukuran video mentah dari HP (bitrate perekaman ±1 Mbps → 5 menit ≈ 40 MB) */
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
/** Batas satu potongan (Nginx/Cloudflare aman) */
const MAX_CHUNK = 2 * 1024 * 1024;

async function load(mediaId: string) {
  const user = await getUser();
  if (!user?.can("retur.manage")) return { error: Response.json({ error: "Tidak punya izin" }, { status: 403 }) };
  const m = await prisma.returnMedia.findUnique({ where: { id: mediaId } });
  if (!m || m.kind !== "VIDEO") return { error: Response.json({ error: "Video tidak ditemukan" }, { status: 404 }) };
  return { user, m };
}

/** Posisi unggah (untuk melanjutkan setelah sinyal putus) */
export async function GET(_req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await params;
  const x = await load(mediaId);
  if (x.error) return x.error;
  const received = x.m.status === "UPLOADING" && x.m.storageKey ? await mediaStore.size(x.m.storageKey) : x.m.received;
  return Response.json({ status: x.m.status, received });
}

/** Satu potongan video: PUT ?offset=<byte> (urut). Offset tidak cocok → 409 + posisi server agar klien menyesuaikan. */
export async function PUT(req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await params;
  const x = await load(mediaId);
  if (x.error) return x.error;
  if (x.m.status !== "UPLOADING" || !x.m.storageKey) return Response.json({ error: "Unggahan sudah selesai" }, { status: 409 });
  const offset = Number(new URL(req.url).searchParams.get("offset"));
  if (!Number.isInteger(offset) || offset < 0) return Response.json({ error: "offset tidak valid" }, { status: 400 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return Response.json({ received: offset });
  if (buf.length > MAX_CHUNK) return Response.json({ error: "Potongan terlalu besar" }, { status: 413 });
  if (offset + buf.length > MAX_VIDEO_BYTES) return Response.json({ error: "Video terlalu besar (maks 400 MB)" }, { status: 413 });
  try {
    const received = await mediaStore.append(x.m.storageKey, buf, offset);
    await prisma.returnMedia.update({ where: { id: x.m.id }, data: { received } });
    return Response.json({ received });
  } catch (e) {
    if (e instanceof MediaOffsetError) return Response.json({ error: e.message, received: e.received }, { status: 409 });
    throw e;
  }
}

/** Selesai merekam: POST ?finish=1 {total, durationSec} → diproses (kompres + thumbnail) di latar belakang */
export async function POST(req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await params;
  const x = await load(mediaId);
  if (x.error) return x.error;
  if (x.m.status !== "UPLOADING" || !x.m.storageKey) return Response.json({ status: x.m.status });
  const body = (await req.json().catch(() => ({}))) as { total?: number; durationSec?: number };
  const size = await mediaStore.size(x.m.storageKey);
  if (typeof body.total === "number" && body.total !== size) return Response.json({ error: "Video belum terunggah semua", received: size }, { status: 409 });
  if (!size) return Response.json({ error: "Video kosong" }, { status: 400 });
  const durationSec = Math.max(0, Math.round(Number(body.durationSec) || 0)) || null;
  await prisma.returnMedia.update({ where: { id: x.m.id }, data: { status: "PROCESSING", received: size, size, durationSec } });
  void enqueueVideo(x.m.id);
  return Response.json({ status: "PROCESSING", size });
}
