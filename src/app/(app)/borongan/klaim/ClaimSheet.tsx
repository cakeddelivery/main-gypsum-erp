import { DocSheet, fmtLong, fmtRange } from "@/components/DocSheet";
import { todayStr } from "@/lib/time";
import type { ClaimBreakdown } from "@/lib/boronganClaim";
import type { Letterhead } from "@/lib/letterhead";
import type { claimDetail } from "@/lib/boronganClaim";
import { ClaimTable, CLAIM_DOC_STATUS, CLAIM_STATUS_LABEL } from "../KlaimViews";

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

/** Dokumen "Pengajuan Klaim" (draf atau klaim tersimpan), semua pekerja atau satu pekerja */
export function ClaimDocSheet({ id, lh, number, point, status, from, to, setoran, b, workerOnly, worker, signer }: {
  id: string; lh: Letterhead; number: string | null; point: string; status: keyof typeof CLAIM_DOC_STATUS; from: string | null; to: string | null;
  setoran?: number; b: ClaimBreakdown; workerOnly?: boolean; worker?: string | null; signer?: string;
}) {
  return (
    <DocSheet
      id={id}
      lh={lh}
      eyebrow={workerOnly ? "Rincian fee pekerja borongan" : "Pengajuan klaim upah borongan"}
      title={`${number ?? "Pratinjau klaim"} · ${point}${workerOnly && worker ? ` · ${worker}` : ""}`}
      subtitle={`Status: ${CLAIM_DOC_STATUS[status]} · dicetak ${fmtLong(todayStr())}${setoran ? ` · ${setoran} setoran` : ""}`}
      meta={from && to ? { label: "Periode setoran", value: fmtRange(from, to) } : undefined}
      notes={workerOnly ? ["Upah = setoran yang diterima divisi × upah satuan. Reject tidak dibayar."] : ["Upah = setoran yang diterima divisi × upah satuan. Reject tidak dibayar dan tidak memotong upah.", "Fee driver dibukukan sebagai beban transport borongan."]}
      signer={signer ?? "Finance / Owner"}
    >
      <ClaimTable b={b} doc workerOnly={workerOnly} />
    </DocSheet>
  );
}
