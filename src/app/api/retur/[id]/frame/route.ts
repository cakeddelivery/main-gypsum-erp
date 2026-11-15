import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mediaStore } from "@/lib/mediaStore";
import { compressImage } from "@/lib/imageCompress";

/** Potongan gambar dari video (thumbnail = gambar pertama). Disimpan permanen walau videonya nanti dihapus. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user?.can("retur.manage")) return Response.json({ error: "Tidak punya izin" }, { status: 403 });
  const { id } = await params;
  const r = await prisma.returnCase.findUnique({ where: { id }, select: { id: true } });
  if (!r) return Response.json({ error: "Retur tidak ditemukan" }, { status: 404 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length || buf.length > 3 * 1024 * 1024 || buf.subarray(0, 2).toString("hex") !== "ffd8") return Response.json({ error: "Gambar tidak valid" }, { status: 400 });
  const c = await compressImage(buf).catch(() => ({ buf, changed: false }));
  const data = c.changed ? c.buf : buf;
  const hasThumb = await prisma.returnMedia.count({ where: { returnId: id, kind: "THUMB", status: "READY" } });
  const count = await prisma.returnMedia.count({ where: { returnId: id, kind: "FRAME" } });
  if (hasThumb && count >= 12) return Response.json({ ok: true, skipped: true });
  const key = mediaStore.newKey("retur", "jpg");
  await mediaStore.write(key, data);
  const m = await prisma.returnMedia.create({ data: { returnId: id, kind: hasThumb ? "FRAME" : "THUMB", status: "READY", storageKey: key, mime: "image/jpeg", size: data.length, createdBy: user.name } });
  return Response.json({ ok: true, id: m.id });
}
