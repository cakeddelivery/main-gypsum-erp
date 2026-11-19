import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canViewContract } from "@/lib/contract";
import { qrSvg } from "@/lib/qr";
import { baseUrl } from "@/lib/baseUrl";
import { ContractDoc } from "@/app/(app)/kontrak/ContractDoc";
import { PrintBar } from "../../panduan/PrintBar";

export const metadata = { title: "Cetak kontrak kerja" };

/** Kontrak siap cetak / simpan PDF (tema terang, teks vektor, multi-halaman, QR verifikasi). Hanya kontrak yang sudah ditandatangani HRD. */
export default async function CetakKontrak({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ print?: string }> }) {
  const user = await requirePerm("hrd.manage", "payroll.self");
  const { id } = await params;
  const q = await searchParams;
  const c = await prisma.contract.findUnique({ where: { id } });
  if (!c || !c.hrdSignedAt || !canViewContract(user, c)) notFound();
  const verifyUrl = `${await baseUrl()}/verifikasi/${c.verifyCode}`;
  return (
    <div className="cetak-kontrak theme-light bg-white">
      <PrintBar auto={q.print === "1"} title={`Kontrak ${c.number}`} />
      <div className="mx-auto max-w-[900px] p-4 print:p-0">
        <ContractDoc doc={c} qr={await qrSvg(verifyUrl, 92)} verifyUrl={verifyUrl} />
      </div>
    </div>
  );
}
