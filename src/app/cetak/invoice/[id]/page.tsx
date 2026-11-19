import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { InvoiceDoc } from "@/app/(app)/penjualan/invoice/InvoiceDoc";
import { PrintBar } from "../../panduan/PrintBar";

export const metadata = { title: "Cetak invoice" };

/** Invoice siap cetak / simpan PDF (tema terang, teks vektor) */
export default async function CetakInvoice({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ print?: string }> }) {
  await requirePerm("sales.view");
  const { id } = await params;
  const q = await searchParams;
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) notFound();
  const [store, sale] = await Promise.all([
    prisma.store.findUnique({ where: { id: inv.storeId }, select: { name: true } }),
    inv.saleId ? prisma.sale.findUnique({ where: { id: inv.saleId }, select: { paid: true } }) : null,
  ]);
  return (
    <div className="cetak-invoice theme-light bg-white">
      <PrintBar auto={q.print === "1"} title={`Invoice ${inv.number}`} />
      <div className="mx-auto max-w-[1000px] p-4 print:p-0">
        <InvoiceDoc inv={inv} lh={await letterhead()} salePaid={sale?.paid} storeName={store?.name ?? inv.storeCode} id="invoice-print" />
      </div>
    </div>
  );
}
