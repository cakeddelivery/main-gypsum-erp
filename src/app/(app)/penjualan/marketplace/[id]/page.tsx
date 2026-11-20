import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL, shownStatus, STATUS_LABEL } from "@/lib/marketplace/rules";
import { resolveSkuKeys } from "@/lib/marketplace/sku";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { invoiceFromOrderAction, toggleComplaintAction } from "../actions";
import { MpNav } from "../MpNav";

export const metadata = { title: "Detail Pesanan Marketplace" };

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const { id } = await params;
  const o = await prisma.marketplaceOrder.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } }, income: true } });
  if (!o) notFound();
  const [store, res, inv, ret, comp] = await Promise.all([
    prisma.store.findUnique({ where: { id: o.storeId }, select: { name: true } }),
    resolveSkuKeys(o.lines.map((l) => l.skuKey)),
    o.invoiceId ? prisma.invoice.findUnique({ where: { id: o.invoiceId }, select: { id: true, number: true } }) : null,
    o.returnCaseId ? prisma.returnCase.findUnique({ where: { id: o.returnCaseId }, select: { id: true, number: true } }) : null,
    o.complaintId ? prisma.complaint.findUnique({ where: { id: o.complaintId }, select: { id: true, number: true } }) : null,
  ]);
  const st = shownStatus(o.status, !!o.income);
  const fee = (o.income?.feeDetail ?? {}) as Record<string, number>;
  return (
    <div className="space-y-4">
      <PageHeader title={o.orderNo} subtitle={`${CHANNEL_LABEL[o.channel]} · ${store?.name ?? ""} · ${fmtDate(o.orderedAt)}`} actions={<Link href="/penjualan/marketplace" className="btn-secondary">Kembali</Link>} />
      <MpNav current="pesanan" />
      <div className="flex flex-wrap gap-2">
        <Badge tone={st === "CAIR" ? "green" : st === "PIUTANG" ? "amber" : st === "RETUR" ? "red" : "gray"}>{STATUS_LABEL[st]}</Badge>
        {o.complaint && <Badge tone="red">Komplain{o.complaintNote ? `: ${o.complaintNote}` : ""}</Badge>}
        {o.rawStatus && <span className="text-xs text-slate-500">Status platform: {o.rawStatus}{o.rawSubstatus ? ` / ${o.rawSubstatus}` : ""}{o.rawReturn ? ` · ${o.rawReturn}` : ""}</span>}
      </div>
      <Card title="Produk">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>SKU / produk</th><th className="num">Qty</th><th className="num">Harga</th><th className="num">Jumlah</th><th>Dikenali sebagai</th></tr></thead>
            <tbody>
              {o.lines.map((l) => {
                const r = res.get(l.skuKey);
                return (
                  <tr key={l.id}>
                    <td>{[l.sku, l.variation].filter(Boolean).join(" · ")}<div className="text-xs text-slate-400">{l.name}</div></td>
                    <td className="num">{l.qty}</td><td className="num">{idr(l.unitPrice)}</td><td className="num">{idr(l.amount)}</td>
                    <td>{!r ? <Link href="/penjualan/marketplace/sku" className="link text-xs">Belum dipetakan</Link> : r.kind === "PRODUK" ? r.itemName : <Badge tone="purple">Extra Packing {r.variant}</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Nilai & pencairan">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-slate-500">Nilai pesanan</dt><dd className="text-right">{idr(o.total)}</dd>
            <dt className="text-slate-500">Ongkir dibayar pembeli</dt><dd className="text-right">{idr(o.shippingPaid)}</dd>
            {o.refundAmount > 0n && <><dt className="text-slate-500">Refund</dt><dd className="text-right">{idr(o.refundAmount)}</dd></>}
            <dt className="text-slate-500">Uang cair</dt><dd className="text-right font-medium">{o.income ? idr(o.income.released) : st === "BATAL" ? "0" : "belum"}</dd>
            {o.income && <><dt className="text-slate-500">Tanggal dilepas</dt><dd className="text-right">{fmtDateTime(o.income.releasedAt)}</dd><dt className="text-slate-500">Total biaya platform</dt><dd className="text-right">{idr(o.income.fees)}</dd></>}
          </dl>
          {Object.keys(fee).length > 0 && <ul className="mt-2 border-t pt-2 text-xs text-slate-600">{Object.entries(fee).map(([k, v]) => <li key={k} className="flex justify-between"><span className="capitalize">{k}</span><span>{idr(v)}</span></li>)}</ul>}
        </Card>
        <Card title="Pengiriman & wilayah">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-slate-500">No. resi</dt><dd className="break-all text-right">{o.trackingNo ?? "-"}</dd>
            <dt className="text-slate-500">Kurir / opsi</dt><dd className="text-right">{o.shipOption ?? o.courier ?? "-"}</dd>
            <dt className="text-slate-500">Kota/Kab.</dt><dd className="text-right">{o.city ?? "-"}</dd>
            <dt className="text-slate-500">Provinsi</dt><dd className="text-right">{o.province ?? "-"}</dd>
            <dt className="text-slate-500">Metode bayar</dt><dd className="text-right">{o.paymentMethod ?? "-"}</dd>
            {o.creatorHandle && <><dt className="text-slate-500">Kreator</dt><dd className="text-right">{o.creatorHandle}</dd></>}
          </dl>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {ret && <Link className="link" href={`/retur/${ret.id}`}>Retur {ret.number}</Link>}
            {comp && <Link className="link" href={`/retur/komplain/${comp.id}`}>Komplain {comp.number}</Link>}
          </div>
        </Card>
      </div>
      {canManage && (
        <Card title="Tindakan">
          <div className="flex flex-wrap items-end gap-3">
            {inv ? <Link href={`/penjualan/invoice/${inv.id}`} className="btn-secondary">Invoice {inv.number}</Link> : st !== "BATAL" && (
              <ActionForm action={invoiceFromOrderAction}><input type="hidden" name="id" value={o.id} /><Submit className="btn-secondary" pendingText="Menerbitkan…">Buat invoice</Submit></ActionForm>
            )}
            <ActionForm action={toggleComplaintAction} className="flex items-end gap-2">
              <input type="hidden" name="id" value={o.id} />
              {!o.complaint && <input name="note" className="input" placeholder="Catatan komplain (opsional)" />}
              <Submit className="btn-secondary">{o.complaint ? "Cabut tanda komplain" : "Tandai komplain"}</Submit>
            </ActionForm>
          </div>
        </Card>
      )}
    </div>
  );
}
