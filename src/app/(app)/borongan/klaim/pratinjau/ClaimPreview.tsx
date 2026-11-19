import Link from "next/link";
import type { Letterhead } from "@/lib/letterhead";
import { Badge, Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport } from "@/components/DocSheet";
import { ClaimTable, CLAIM_DOC_STATUS } from "../../KlaimViews";
import { ClaimDocSheet } from "../ClaimSheet";
import type { ClaimDoc } from "./data";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const TONE = { DRAF: "gray", MENUNGGU: "amber", DIBAYAR: "green", DITOLAK: "red" } as const;

/** Pratinjau dokumen klaim di HP: filter semua / per pekerja, tabel rapi (geser di dalam kartu), unduh JPG/PDF */
export function ClaimPreview({ d, lh, base, printHref, actions }: { d: ClaimDoc; lh: Letterhead; base: string; printHref: string; actions?: React.ReactNode }) {
  const file = `${d.number ?? `Pratinjau-klaim-${d.point}`}${d.worker ? `-${d.worker.name}` : ""}`.replace(/\s+/g, "-");
  const hidden = base.includes("?") ? Object.fromEntries(new URLSearchParams(base.split("?")[1])) : {};
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={d.worker ? `Fee ${d.worker.name}` : `Pengajuan klaim · ${d.point}`} subtitle={`${d.number ?? "Pratinjau (belum diajukan)"} · ${d.point}${d.setoran ? ` · ${d.setoran} setoran` : ""}`} />
      <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[d.status]}>{CLAIM_DOC_STATUS[d.status]}</Badge></div>
      <form method="get" action={base.split("?")[0]} className="card flex flex-wrap items-end gap-2 p-3">
        {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Field label="Tampilkan" className="min-w-0 flex-1">
          <select name="pekerja" defaultValue={d.worker?.id ?? ""} className="input">
            <option value="">Semua pekerja</option>
            {d.full.workers.map((w) => <option key={w.id} value={w.id}>{w.name} ({rp(w.total)})</option>)}
          </select>
        </Field>
        <button type="submit" className="btn-secondary">Terapkan</button>
      </form>
      <ClaimTable b={d.b} workerOnly={!!d.worker} />
      <div className="flex flex-wrap gap-2">
        <DownloadJpg targetId="klaim-doc" filename={`${file}.jpg`} label="👁 Lihat dokumen" className="btn-primary" pdfHref={printHref} />
        <Link href="/borongan?tab=klaim" className="btn-secondary">Kembali</Link>
      </div>
      {actions}
      <DocExport>
        <ClaimDocSheet id="klaim-doc" lh={lh} number={d.number} point={d.point} status={d.status} from={d.from} to={d.to} setoran={d.setoran} b={d.b} workerOnly={!!d.worker} worker={d.worker?.name} signer={d.signer} />
      </DocExport>
    </div>
  );
}
