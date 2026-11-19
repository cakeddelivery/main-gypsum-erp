import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { PrintBar } from "../../panduan/PrintBar";
import { ReturnClaimSheet, returnClaimInclude } from "@/app/(app)/retur/[id]/klaim/ReturnClaimSheet";

export const metadata = { title: "Cetak Klaim Retur" };

export default async function CetakKlaimRetur({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ print?: string }> }) {
  await requirePerm("retur.manage");
  const { id } = await params;
  const q = await searchParams;
  const r = await prisma.returnCase.findUnique({ where: { id }, include: returnClaimInclude });
  if (!r) notFound();
  return (
    <div>
      <PrintBar auto={q.print === "1"} title={`Klaim ${r.number}`} />
      <ReturnClaimSheet r={r} lh={await letterhead()} id="klaim-retur" />
    </div>
  );
}
