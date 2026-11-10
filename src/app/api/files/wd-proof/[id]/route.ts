import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { proofContentType, readProof } from "@/lib/storage";

/** Bukti "uang diterima" withdraw TikTok bersifat privat: hanya pengguna dengan izin finance.view */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !user.can("finance.view")) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const t = await prisma.financeTransaction.findUnique({ where: { id }, select: { receivedProofPath: true, receivedProofMime: true } });
  if (!t?.receivedProofPath) return new Response("Not found", { status: 404 });
  const buf = await readProof(t.receivedProofPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": proofContentType(buf, t.receivedProofMime), "cache-control": "private, no-store", "content-disposition": "inline" } });
}
