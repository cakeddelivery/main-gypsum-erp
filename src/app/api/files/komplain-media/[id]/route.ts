import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { serveMedia } from "@/lib/mediaServe";

/** Bukti dari pembeli (foto/video) pada komplain: privat, untuk yang menangani komplain & refund */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !["refund.request", "refund.approve", "refund.pay", "accounting.view"].some((p) => user.can(p as never))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const m = await prisma.complaintMedia.findUnique({ where: { id } });
  if (!m) return new Response("Not found", { status: 404 });
  return serveMedia(req, m.storageKey, m.mime);
}
