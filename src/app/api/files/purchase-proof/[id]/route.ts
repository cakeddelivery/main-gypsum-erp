import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readProof } from "@/lib/storage";

/** Foto bukti transfer pembelian bersifat privat: hanya yang boleh melihat menu pembelian */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !(user.can("stock.view") || user.can("accounting.view"))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const p = await prisma.purchase.findUnique({ where: { id }, select: { proofPath: true, proofMime: true } });
  if (!p?.proofPath) return new Response("Not found", { status: 404 });
  const buf = await readProof(p.proofPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": p.proofMime ?? "application/octet-stream", "cache-control": "private, no-store", "content-disposition": "inline" } });
}
