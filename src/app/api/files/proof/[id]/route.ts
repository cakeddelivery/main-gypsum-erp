import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readProof } from "@/lib/storage";

/** Bukti transaksi bersifat privat: hanya pengguna dengan izin finance.view */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !user.can("finance.view")) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const t = await prisma.financeTransaction.findUnique({ where: { id }, select: { proofPath: true, proofMime: true } });
  if (!t?.proofPath) return new Response("Not found", { status: 404 });
  const buf = await readProof(t.proofPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": t.proofMime ?? "application/octet-stream", "cache-control": "private, no-store", "content-disposition": "inline" } });
}
