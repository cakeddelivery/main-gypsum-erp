import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { boronganScope, coordinatorsAt } from "@/lib/borongan";
import { canRequestClaim } from "@/lib/boronganClaim";
import { ActionForm, Submit } from "@/components/ActionForm";
import { canSeeClaim } from "../access";
import { klaimSekarang } from "../../kirimanActions";
import { claimDoc } from "./data";
import { ClaimPreview } from "./ClaimPreview";

export const metadata = { title: "Pratinjau pengajuan klaim" };

/** Pratinjau "Pengajuan Klaim" (upah titik yang belum diklaim): semua pekerja / per pekerja, unduh, Ajukan ke Finance */
export default async function PratinjauKlaim({ searchParams }: { searchParams: Promise<{ titik?: string; pekerja?: string }> }) {
  const user = await requirePerm("borongan.view");
  const sp = await searchParams;
  if (!sp.titik || !(await canSeeClaim(user, sp.titik))) notFound();
  const d = await claimDoc({ pointId: sp.titik, workerId: sp.pekerja || null });
  if (!d) notFound();
  const scope = await boronganScope(prisma, user);
  const hasCoordinator = (await prisma.boronganPerson.count({ where: coordinatorsAt(d.pointId) })) > 0;
  const canAsk = canRequestClaim(scope, d.pointId, hasCoordinator) && d.full.totals.all > 0;
  const q = new URLSearchParams({ titik: d.pointId, ...(d.worker ? { pekerja: d.worker.id } : {}) });
  return (
    <ClaimPreview
      d={d}
      lh={await letterhead()}
      base={`/borongan/klaim/pratinjau?titik=${d.pointId}`}
      printHref={`/cetak/klaim/pratinjau?${q}&print=1`}
      actions={canAsk && (
        <ActionForm action={klaimSekarang} confirm={`Ajukan klaim upah ${d.point} Rp${d.full.totals.all.toLocaleString("id-ID")} ke Finance?`}>
          <input type="hidden" name="pointId" value={d.pointId} />
          <Submit className="btn-primary w-full">Ajukan ke Finance (Rp{d.full.totals.all.toLocaleString("id-ID")})</Submit>
        </ActionForm>
      )}
    />
  );
}
