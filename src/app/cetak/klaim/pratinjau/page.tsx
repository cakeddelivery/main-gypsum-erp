import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { letterhead } from "@/lib/letterhead";
import { ClaimDocSheet } from "@/app/(app)/borongan/klaim/ClaimSheet";
import { canSeeClaim } from "@/app/(app)/borongan/klaim/access";
import { claimDoc } from "@/app/(app)/borongan/klaim/pratinjau/data";
import { PrintBar } from "../../panduan/PrintBar";

export const metadata = { title: "Cetak pengajuan klaim" };

/** Pengajuan klaim (draf atau klaim tersimpan, semua / per pekerja) siap cetak / simpan PDF, tema terang */
export default async function CetakPratinjauKlaim({ searchParams }: { searchParams: Promise<{ titik?: string; klaim?: string; pekerja?: string; print?: string }> }) {
  const user = await requirePerm("borongan.view");
  const q = await searchParams;
  const d = await claimDoc({ pointId: q.titik, claimId: q.klaim, workerId: q.pekerja || null });
  if (!d || !(await canSeeClaim(user, d.pointId))) notFound();
  return (
    <div className="cetak-klaim theme-light bg-white">
      <PrintBar auto={q.print === "1"} title={`Klaim ${d.number ?? d.point}`} />
      <div className="mx-auto max-w-[1000px] p-4 print:p-0">
        <ClaimDocSheet id="klaim-print" lh={await letterhead()} number={d.number} point={d.point} status={d.status} from={d.from} to={d.to} setoran={d.setoran} b={d.b} workerOnly={!!d.worker} worker={d.worker?.name} signer={d.signer} />
      </div>
    </div>
  );
}
