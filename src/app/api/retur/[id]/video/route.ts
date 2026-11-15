import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mediaStore } from "@/lib/mediaStore";
import { returnSetting } from "@/lib/returns";

/**
 * Mulai rekam video unboxing: buat catatan media (UPLOADING). Potongan video lalu dikirim bertahap ke
 * /api/retur/media/<id> selama perekaman berjalan (tahan sinyal putus), dan diselesaikan dengan ?finish=1.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user?.can("retur.manage")) return Response.json({ error: "Tidak punya izin" }, { status: 403 });
  const { id } = await params;
  const r = await prisma.returnCase.findUnique({ where: { id }, select: { id: true, number: true, trackingNo: true, cancelledAt: true, status: true } });
  if (!r) return Response.json({ error: "Retur tidak ditemukan" }, { status: 404 });
  if (r.cancelledAt || r.status === "SELESAI") return Response.json({ error: "Retur sudah selesai/dibatalkan" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { mime?: string; recordedAt?: string; device?: string };
  const mime = String(body.mime ?? "video/webm").split(";")[0];
  if (!/^video\/(webm|mp4|quicktime|x-matroska)$/.test(mime)) return Response.json({ error: "Format video tidak didukung" }, { status: 400 });
  const ext = mime === "video/mp4" ? "mp4" : mime === "video/quicktime" ? "mov" : "webm";
  const recordedAt = body.recordedAt && !Number.isNaN(Date.parse(body.recordedAt)) ? new Date(body.recordedAt) : new Date();
  const m = await prisma.returnMedia.create({
    data: {
      returnId: r.id, kind: "VIDEO", status: "UPLOADING", storageKey: mediaStore.newKey("retur", ext), mime, recordedAt, createdBy: user.name,
      meta: { trackingNo: r.trackingNo, number: r.number, device: String(body.device ?? "").slice(0, 200), store: mediaStore.driver },
    },
  });
  return Response.json({ mediaId: m.id, maxMinutes: await returnSetting("videoMaxMinutes") });
}
