import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readProof } from "@/lib/storage";

/** Bukti transfer dana sisihan (privat): hanya yang boleh mengelola sisihan / melihat akuntansi */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !(user.can("finance.approve") || user.can("accounting.view"))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const e = await prisma.reserveEntry.findUnique({ where: { id }, select: { proofPath: true, proofMime: true } });
  if (!e?.proofPath) return new Response("Not found", { status: 404 });
  const buf = await readProof(e.proofPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": e.proofMime ?? "application/octet-stream", "cache-control": "private, no-store", "content-disposition": "inline" } });
}
