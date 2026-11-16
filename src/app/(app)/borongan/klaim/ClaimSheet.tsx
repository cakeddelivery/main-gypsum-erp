import { DocSheet, fmtRange } from "@/components/DocSheet";
import type { Letterhead } from "@/lib/letterhead";
import type { claimDetail } from "@/lib/boronganClaim";
import { ClaimTable, CLAIM_STATUS_LABEL } from "../KlaimViews";

type Detail = NonNullable<Awaited<ReturnType<typeof claimDetail>>>;

/** Lembar klaim upah ber-kop surat untuk JPG & PDF (selalu tema terang) */
export function ClaimSheet({ c, lh, id }: { c: Detail; lh: Letterhead; id: string }) {
  return (
    <DocSheet
      id={id}
      lh={lh}
      eyebrow="Klaim upah borongan"
      title={`${c.number} · ${c.point.name}`}
      subtitle={`Status: ${CLAIM_STATUS_LABEL[c.status]}${c.settlement ? ` (${c.settlement.number})` : ""} · diajukan ${c.requestedBy}`}
      meta={c.from && c.to ? { label: "Periode setoran", value: fmtRange(c.from, c.to) } : undefined}
      notes={["Upah = setoran yang diterima divisi × upah satuan. Reject tidak dibayar dan tidak memotong upah.", "Fee driver dibukukan sebagai beban transport borongan."]}
      signer={c.decidedBy ?? "Finance / Owner"}
    >
      <ClaimTable b={c.breakdown} doc />
    </DocSheet>
  );
}
