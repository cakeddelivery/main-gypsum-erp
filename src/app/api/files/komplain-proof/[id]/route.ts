import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { proofContentType, readProof } from "@/lib/storage";
import { canSeePayee } from "@/lib/complaints";

/** Bukti transfer refund (berisi rekening pembeli): hanya pengaju, Finance, Owner */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const c = await prisma.complaint.findUnique({ where: { id }, select: { proofPath: true, proofMime: true, createdById: true } });
  if (!c?.proofPath) return new Response("Not found", { status: 404 });
  if (!canSeePayee(c, user)) return new Response("Forbidden", { status: 403 });
  const buf = await readProof(c.proofPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": proofContentType(buf, c.proofMime), "cache-control": "private, no-store", "content-disposition": "inline" } });
}
