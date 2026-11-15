import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canDecideLeave } from "@/lib/leave";
import { proofContentType, readProof } from "@/lib/storage";

/** Lampiran izin/sakit (surat dokter): hanya pengaju, Supervisor/Owner, dan pengelola absensi */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const r = await prisma.leaveRequest.findUnique({ where: { id }, select: { employeeId: true, attachmentPath: true } });
  if (!r?.attachmentPath) return new Response("Not found", { status: 404 });
  const own = !!user.employeeId && user.employeeId === r.employeeId;
  if (!own && !canDecideLeave(user.role) && !user.can("attendance.manage")) return new Response("Forbidden", { status: 403 });
  const buf = await readProof(r.attachmentPath);
  return new Response(new Uint8Array(buf), { headers: { "content-type": proofContentType(buf), "cache-control": "private, no-store" } });
}
