import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readProof } from "@/lib/storage";

/** Lampiran mutasi rekening dari cek saldo pagi bersifat privat: hanya Owner/Finance (penyetuju) & akuntansi */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const user = await getUser();
  if (!user || !(user.can("finance.approve") || user.can("accounting.view"))) return new Response("Forbidden", { status: 403 });
  const { id, index } = await params;
  const c = await prisma.balanceCheck.findUnique({ where: { id }, select: { attachments: true } });
  const a = ((c?.attachments as { path: string; mime: string }[] | null) ?? [])[Number(index)];
  if (!a?.path) return new Response("Not found", { status: 404 });
  const buf = await readProof(a.path);
  return new Response(new Uint8Array(buf), { headers: { "content-type": a.mime || "application/octet-stream", "cache-control": "private, no-store", "content-disposition": "inline" } });
}
