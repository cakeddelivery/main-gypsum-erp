import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readProof } from "@/lib/storage";
import { toEntries } from "@/lib/shiftReport";

const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Foto bukti checklist laporan shift: hanya pengguna yang boleh melihat laporan divisi tersebut */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const user = await getUser();
  if (!user || !user.can("report.view")) return new Response("Forbidden", { status: 403 });
  const { id, index } = await params;
  const r = await prisma.shiftReport.findUnique({ where: { id }, select: { checklist: true, divisionId: true } });
  if (!r) return new Response("Not found", { status: 404 });
  if ((user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR") && user.divisionId !== r.divisionId) return new Response("Forbidden", { status: 403 });
  const path = toEntries(r.checklist)[Number(index)]?.photoPath;
  if (!path) return new Response("Not found", { status: 404 });
  const buf = await readProof(path);
  return new Response(new Uint8Array(buf), { headers: { "content-type": MIME[path.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "private, max-age=86400" } });
}
