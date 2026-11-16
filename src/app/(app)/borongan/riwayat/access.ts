import { prisma } from "@/lib/db";

type User = { role: string; divisionId: string | null; can: (p: "borongan.manage") => boolean };

/** Riwayat Pengiriman: Owner, Supervisor / pengelola borongan, tim Assembling, Giftbox, dan Oven */
export async function canSeeHistory(user: User) {
  if (user.can("borongan.manage") || user.role === "OWNER" || user.role === "SUPERVISOR") return true;
  if (!user.divisionId) return false;
  const d = await prisma.division.findUnique({ where: { id: user.divisionId }, select: { name: true, reportTemplate: true } });
  return !!d && (d.reportTemplate === "ASSEMBLING" || d.reportTemplate === "GIFTBOX" || /oven/i.test(d.name));
}
