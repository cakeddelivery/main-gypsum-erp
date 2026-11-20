import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/time";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Periode dari query; bawaan = bulan dari pencairan terakhir yang ada sampai hari ini */
export async function periodOf(sp: { dari?: string; sampai?: string }) {
  const last = await prisma.marketplaceIncome.findFirst({ where: { releasedAt: { not: null } }, orderBy: { releasedAt: "desc" }, select: { releasedAt: true } });
  const base = (last?.releasedAt ? new Date(last.releasedAt.getTime() + 7 * 3600000) : new Date()).toISOString().slice(0, 7);
  const from = DATE.test(sp.dari ?? "") ? sp.dari! : `${base}-01`;
  const to = DATE.test(sp.sampai ?? "") ? sp.sampai! : last?.releasedAt ? new Date(Date.UTC(+base.slice(0, 4), +base.slice(5), 0)).toISOString().slice(0, 10) : todayStr();
  return { from, to };
}
