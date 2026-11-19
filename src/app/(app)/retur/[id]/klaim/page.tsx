import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { ReturnClaimSheet, returnClaimInclude } from "./ReturnClaimSheet";

export const metadata = { title: "Laporan Klaim Retur" };

/** Laporan klaim marketplace per retur: pratinjau, unduh JPG & PDF (Supervisor/Finance/Owner) */
export default async function ReturKlaim({ params }: { params: Promise<{ id: string }> }) {
  await requirePerm("retur.manage");
  const { id } = await params;
  const r = await prisma.returnCase.findUnique({ where: { id }, include: returnClaimInclude });
  if (!r) notFound();
  const file = `Klaim-${r.number}`;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Laporan klaim ${r.number}`} subtitle={r.trackingNo} />
      <div className="flex flex-wrap gap-2">
        <DownloadJpg targetId="klaim-retur" filename={file} label="🖼️ Unduh JPG" />
        <a href={`/cetak/retur/${r.id}?print=1`} target="_blank" rel="noopener" className="btn-secondary">📄 Unduh PDF</a>
        <Link href={`/retur/${r.id}`} className="btn-secondary">Kembali</Link>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200"><ReturnClaimSheet r={r} lh={await letterhead()} id="klaim-retur" /></div>
    </div>
  );
}
