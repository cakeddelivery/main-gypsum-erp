import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { proofContentType, readProof } from "@/lib/storage";

/** Foto nota barang masuk laporan shift: yang boleh melihat laporan divisinya atau menu pembelian */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !(user.can("report.view") || user.can("stock.view") || user.can("accounting.view"))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const x = await prisma.shiftReceipt.findUnique({ where: { id }, select: { photoPath: true, photoMime: true, divisionId: true } });
  if (!x?.photoPath) return new Response("Not found", { status: 404 });
  const ownOnly = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR";
  if (ownOnly && user.divisionId !== x.divisionId) return new Response("Forbidden", { status: 403 });
  const buf = await readProof(x.photoPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": proofContentType(buf, x.photoMime), "cache-control": "private, no-store", "content-disposition": "inline" } });
}
