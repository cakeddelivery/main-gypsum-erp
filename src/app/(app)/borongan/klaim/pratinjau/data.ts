import { prisma } from "@/lib/db";
import { claimDetail, onlyWorker, pointWageSummary, type ClaimBreakdown } from "@/lib/boronganClaim";
import type { CLAIM_DOC_STATUS } from "../../KlaimViews";

export type ClaimDoc = {
  claimId: string | null; number: string | null; pointId: string; point: string; status: keyof typeof CLAIM_DOC_STATUS;
  from: string | null; to: string | null; setoran: number; full: ClaimBreakdown; b: ClaimBreakdown; worker: { id: string; name: string } | null; signer?: string;
};

/**
 * Data dokumen pengajuan klaim: draf (upah titik yang belum diklaim) atau klaim tersimpan, mode semua / satu pekerja.
 * Pekerja yang tidak ada di klaim → mode semua.
 */
export async function claimDoc(opts: { pointId?: string; claimId?: string; workerId?: string | null }): Promise<ClaimDoc | null> {
  let base: Omit<ClaimDoc, "b" | "worker">;
  if (opts.claimId) {
    const c = await claimDetail(opts.claimId);
    if (!c) return null;
    base = { claimId: c.id, number: c.number, pointId: c.pointId, point: c.point.name, status: c.status, from: c.from, to: c.to, setoran: c.results.length, full: c.breakdown, signer: c.decidedBy ?? undefined };
  } else {
    const p = opts.pointId ? await prisma.boronganPoint.findUnique({ where: { id: opts.pointId }, select: { id: true, name: true } }) : null;
    if (!p) return null;
    const s = await pointWageSummary(p.id);
    base = { claimId: null, number: null, pointId: p.id, point: p.name, status: "DRAF", from: s.from, to: s.to, setoran: s.setoran, full: s.breakdown };
  }
  const w = opts.workerId ? base.full.workers.find((x) => x.id === opts.workerId) : null;
  return { ...base, b: w ? onlyWorker(base.full, w.id) : base.full, worker: w ? { id: w.id, name: w.name } : null };
}
