import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { CHANNELS, channelPrices, invoiceStatus, isChannel } from "@/lib/invoice";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { createInvoiceAction } from "./actions";
import { InvoiceFields } from "./InvoiceFields";

export const metadata = { title: "Invoice" };

export default async function InvoicePage() {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const rows = await prisma.invoice.findMany({ orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 300 });
  const sales = rows.some((r) => r.saleId) ? await prisma.sale.findMany({ where: { id: { in: rows.map((r) => r.saleId).filter((x): x is string => !!x) } }, select: { id: true, paid: true } }) : [];
  const [stores, items, prices] = canManage
    ? await Promise.all([
        prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true, code: true } }),
        prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: true } }),
        channelPrices(),
      ])
    : [[], [], {}];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoice"
        subtitle="Nomor resmi otomatis · unduh ulang sebagai JPG atau PDF"
        actions={<>
          <Link href="/penjualan" className="btn-secondary">Penjualan</Link>
          {canManage && (
            <Modal trigger="+ Buat invoice" title="Buat invoice">
              <ModalForm action={createInvoiceAction} className="space-y-3">
                <InvoiceFields stores={stores} items={items} prices={prices} today={todayStr()} />
                <Submit>Terbitkan invoice</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      {rows.length ? (
        <div className="table-wrap">
          <Paged>
            <table className="tbl">
              <thead><tr><th>Nomor</th><th>Tanggal</th><th>Pembeli</th><th>Channel</th><th className="num">Total</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = invoiceStatus(r, sales.find((s) => s.id === r.saleId)?.paid);
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/penjualan/invoice/${r.id}`} className="link font-mono text-xs">{r.number}</Link></td>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.customerName}</td>
                      <td>{isChannel(r.channel) ? CHANNELS[r.channel].label : r.channel}</td>
                      <td className="num">{idr(r.total)}</td>
                      <td><Badge tone={st.key === "LUNAS" ? "green" : st.key === "BATAL" ? "gray" : "amber"}>{st.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Paged>
        </div>
      ) : (
        <Empty title="Belum ada invoice" hint={canManage ? "Ketuk “+ Buat invoice”, atau buka satu penjualan lalu pilih “Buat invoice”." : "Invoice akan muncul di sini."} />
      )}
    </div>
  );
}
