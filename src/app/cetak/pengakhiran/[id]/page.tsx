import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { contractSettings } from "@/lib/contract";
import { baseUrl } from "@/lib/baseUrl";
import { qrSvg } from "@/lib/qr";
import { TerminationDoc } from "@/app/(app)/kontrak/pengakhiran/TerminationDoc";
import { PrintBar } from "../../panduan/PrintBar";

export const metadata = { title: "Cetak surat pengakhiran" };

/** Surat pengakhiran + slip akhir siap cetak / simpan PDF (hanya yang sudah diterbitkan HRD) */
export default async function CetakPengakhiran({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ print?: string }> }) {
  await requirePerm("hrd.manage");
  const { id } = await params;
  const q = await searchParams;
  const t = await prisma.termination.findUnique({ where: { id }, include: { employee: { select: { division: { select: { name: true } } } } } });
  if (!t || !t.issuedAt) notFound();
  const st = await contractSettings();
  const qr = await qrSvg(`${await baseUrl()}/verifikasi/${t.verifyCode}`, 92);
  return (
    <div className="cetak-pengakhiran theme-light bg-white">
      <PrintBar auto={q.print === "1"} title={`Surat ${t.number}`} />
      <div className="mx-auto max-w-[1000px] p-4 print:p-0">
        <TerminationDoc t={t} lh={await letterhead()} hrdName={st.hrd.name} qr={qr} division={t.employee.division.name} id="pengakhiran-print" />
      </div>
    </div>
  );
}
