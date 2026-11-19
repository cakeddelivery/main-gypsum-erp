import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { PageHeader, Field } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { InvoiceDoc } from "../InvoiceDoc";
import { voidInvoiceAction } from "../actions";

export const metadata = { title: "Invoice" };

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("sales.view");
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) notFound();
  const [store, sale, lh] = await Promise.all([
    prisma.store.findUnique({ where: { id: inv.storeId }, select: { name: true } }),
    inv.saleId ? prisma.sale.findUnique({ where: { id: inv.saleId }, select: { id: true, number: true, paid: true } }) : null,
    letterhead(),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Invoice ${inv.number}`}
        subtitle={sale ? <>Dari penjualan <Link href={`/penjualan/${sale.id}`} className="link">{sale.number}</Link></> : "Dicatat manual"}
        actions={<>
          <Link href="/penjualan/invoice" className="btn-secondary">Kembali</Link>
          <DownloadJpg targetId="invoice" filename={`invoice-${inv.number.replace(/\//g, "-")}`} />
          <a href={`/cetak/invoice/${inv.id}?print=1`} target="_blank" className="btn-secondary">📄 Unduh PDF</a>
          {user.can("sales.manage") && !inv.cancelledAt && (
            <Modal trigger="Batalkan" triggerClass="btn-secondary text-rose-700" title="Batalkan invoice">
              <ModalForm action={voidInvoiceAction} className="space-y-3">
                <input type="hidden" name="id" value={inv.id} />
                <Field label="Alasan (tercatat; nomor tidak dipakai ulang)"><input name="reason" className="input" required minLength={3} /></Field>
                <Submit className="btn-danger">Batalkan invoice</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      <InvoiceDoc inv={inv} lh={lh} salePaid={sale?.paid} storeName={store?.name ?? inv.storeCode} />
    </div>
  );
}
