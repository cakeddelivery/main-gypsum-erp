import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { letterhead } from "@/lib/letterhead";
import { claimDetail } from "@/lib/boronganClaim";
import { ClaimSheet } from "@/app/(app)/borongan/klaim/ClaimSheet";
import { canSeeClaim } from "@/app/(app)/borongan/klaim/access";
import { PrintBar } from "../../panduan/PrintBar";

export const metadata = { title: "Cetak klaim upah" };

/** Klaim upah borongan siap cetak / simpan PDF (tema terang, teks vektor) */
export default async function CetakKlaim({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ print?: string }> }) {
  const user = await requirePerm("borongan.view");
  const { id } = await params;
  const q = await searchParams;
  const c = await claimDetail(id);
  if (!c || !(await canSeeClaim(user, c.pointId))) notFound();
  return (
    <div className="cetak-klaim theme-light bg-white">
      <PrintBar auto={q.print === "1"} title={`Klaim ${c.number}`} />
      <div className="mx-auto max-w-[1000px] p-4 print:p-0">
        <ClaimSheet c={c} lh={await letterhead()} id="klaim-print" />
      </div>
    </div>
  );
}
