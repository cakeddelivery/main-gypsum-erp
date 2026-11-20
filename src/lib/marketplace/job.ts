import { prisma } from "@/lib/db";

/** Impor dianggap macet bila tidak ada kabar lebih dari ini (browser ditutup di tengah jalan) */
export const JOB_STALE_MS = 15 * 60 * 1000;

export async function startJob(actor: { name: string }, total: number, label: string) {
  await prisma.marketplaceImportJob.updateMany({ where: { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - JOB_STALE_MS) } }, data: { status: "FAILED", message: "Terputus (tidak ada kabar lebih dari 15 menit)", finishedAt: new Date() } });
  return prisma.marketplaceImportJob.create({ data: { createdBy: actor.name, total, label: label.slice(0, 200) } });
}

export const stepJob = (id: string, doneCount: number, label?: string) =>
  prisma.marketplaceImportJob.updateMany({ where: { id, status: "RUNNING" }, data: { doneCount, ...(label ? { label: label.slice(0, 200) } : {}) } });

export const finishJob = (id: string, ok: boolean, message: string) =>
  prisma.marketplaceImportJob.updateMany({ where: { id }, data: { status: ok ? "DONE" : "FAILED", message: message.slice(0, 500), finishedAt: new Date() } });

/** Impor yang sedang berjalan (angka laporan bisa setengah jadi). null bila tidak ada. */
export async function runningJob() {
  const j = await prisma.marketplaceImportJob.findFirst({ where: { status: "RUNNING", updatedAt: { gte: new Date(Date.now() - JOB_STALE_MS) } }, orderBy: { createdAt: "desc" } });
  return j ? { id: j.id, by: j.createdBy, total: j.total, done: j.doneCount, label: j.label, since: j.createdAt.toISOString() } : null;
}
