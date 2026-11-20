import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL, shownStatus, STATUS_LABEL } from "@/lib/marketplace/rules";
import { resolveSkuKeys } from "@/lib/marketplace/sku";
import { allocationMap, stageOf } from "@/lib/marketplace/saldo";
import { returnStatusOf } from "@/lib/returns";
import { complaintStatusOf } from "@/lib/complaintShared";
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
  const [store, res, inv, ret, comp, hist, disc, sellerFee] = await Promise.all([
    prisma.store.findUnique({ where: { id: o.storeId }, select: { name: true } }),
    resolveSkuKeys(o.lines.map((l) => l.skuKey)),
    o.invoiceId ? prisma.invoice.findUnique({ where: { id: o.invoiceId }, select: { id: true, number: true } }) : null,
    o.returnCaseId ? prisma.returnCase.findUnique({ where: { id: o.returnCaseId }, include: { lines: { select: { goodQty: true, damagedQty: true, qty: true } } } }) : null,
    o.complaintId ? prisma.complaint.findUnique({ where: { id: o.complaintId } }) : null,
    prisma.marketplaceChange.findMany({ where: { rowId: o.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.marketplaceShipDiscrepancy.findUnique({ where: { storeId_channel_orderNo: { storeId: o.storeId, channel: o.channel, orderNo: o.orderNo } } }),
    prisma.marketplaceSellerFee.findUnique({ where: { storeId_channel_orderNo: { storeId: o.storeId, channel: o.channel, orderNo: o.orderNo } } }),
  ]);
  const extra = (Array.isArray(o.extra) ? o.extra : []) as Record<string, string | number>[];
  const cover = o.incomeId ? (await allocationMap({ storeId: o.storeId, channel: o.channel })).covers.get(o.incomeId) : undefined;
  const stage = o.income ? stageOf(Number(o.income.released), cover) : null;
  const st = shownStatus(o.status, !!o.income, stage === "DITARIK");
  const fee = (o.income?.feeDetail ?? {}) as Record<string, number>;
  return (
    <div className="space-y-4">
      <PageHeader title={o.orderNo} subtitle={`${CHANNEL_LABEL[o.channel]} · ${store?.name ?? ""} · ${fmtDate(o.orderedAt)}`} actions={<Link href="/penjualan/marketplace" className="btn-secondary">Kembali</Link>} />
      <MpNav current="pesanan" />
      <div className="flex flex-wrap gap-2">
        <Badge tone={st === "DITARIK" ? "green" : st === "CAIR" ? "blue" : st === "PIUTANG" ? "amber" : st === "RETUR" ? "red" : "gray"}>{STATUS_LABEL[st]}</Badge>
        {o.needsCheck && <Badge tone="amber">Perlu dicek: {o.needsCheck === "BATAL_SETELAH_CAIR" ? "dibatalkan setelah cair" : "retur setelah cair"}</Badge>}
        {o.affiliate && <Badge tone="purple">Affiliate{o.creatorHandle ? ` · ${o.creatorHandle}` : ""}</Badge>}
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
            {o.income && (cover?.by.length ? <><dt className="text-slate-500">Ditarik</dt><dd className="text-right">{cover.by.map((b) => `${b.date}${b.ref ? ` (ref ${b.ref})` : ""} Rp ${b.amount.toLocaleString("id-ID")}`).join(" · ")}{stage === "SEBAGIAN" && " — sebagian"}</dd></> : <><dt className="text-slate-500">Ditarik</dt><dd className="text-right text-slate-400">belum (masih di saldo marketplace)</dd></>)}
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
          <div className="mt-2 space-y-1 text-sm">
            {ret && <p><Link className="link" href={`/retur/${ret.id}`}>Retur {ret.number}</Link> · <Badge tone={returnStatusOf(ret).tone}>{returnStatusOf(ret).label}</Badge> · baik {ret.lines.reduce((a, l) => a + l.goodQty, 0)} / rusak {ret.lines.reduce((a, l) => a + l.damagedQty, 0)} dari {ret.lines.reduce((a, l) => a + l.qty, 0)} pcs{Number(ret.claimPaidAmount) > 0 ? ` · klaim cair ${idr(ret.claimPaidAmount)}` : ""}</p>}
            {comp && <p><Link className="link" href={`/retur/komplain/${comp.id}`}>Komplain {comp.number}</Link> · <Badge tone={complaintStatusOf(comp).tone}>{complaintStatusOf(comp).label}</Badge>{comp.solution === "REFUND" ? ` · refund ${idr(comp.refundAmount)}` : " · kirim ganti"}</p>}
            {!ret && !comp && (st === "RETUR" || o.complaint) && <p className="text-amber-700">Belum dicatat di menu Retur/Komplain.</p>}
          </div>
        </Card>
      </div>
      {disc && (
        <Card title="Selisih ongkir dari Shopee">
          <p className="text-sm">Estimasi {idr(Number(disc.estimate))} · dibayarkan ke jasa kirim {idr(Number(disc.paid))} · selisih <b>{idr(Number(disc.diff))}</b></p>
          {disc.reason && <p className="mt-1 text-xs text-slate-600">{disc.reason}</p>}
        </Card>
      )}
      {sellerFee && (
        <Card title="Seller Fee (rincian Shopee)">
          <ul className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-5">{[["Biaya platform", sellerFee.platformFee], ["Gratis Ongkir XTRA", sellerFee.xtra], ["Biaya layanan", sellerFee.service], ["Biaya promosi", sellerFee.promo], ["Biaya lainnya", sellerFee.other]].map(([l, v]) => <li key={l as string}><span className="block text-xs text-slate-500">{l as string}</span>{idr(Number(v))}</li>)}</ul>
        </Card>
      )}
      {extra.length > 0 && (
        <Card title="Data lengkap dari file pesanan">
          <details><summary className="cursor-pointer text-sm text-sky-700">Tampilkan semua kolom (tanpa data pribadi pembeli)</summary>
            {extra.map((row, i) => (
              <dl key={i} className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-2 text-xs sm:grid-cols-3">{Object.entries(row).map(([k, v]) => <div key={k}><dt className="text-slate-500">{k}</dt><dd className="break-words">{String(v)}</dd></div>)}</dl>
            ))}
          </details>
        </Card>
      )}
      {hist.length > 0 && (
        <Card title="Riwayat perubahan">
          <ul className="space-y-1 text-sm">{hist.map((h) => <li key={h.id} className={h.undone ? "text-slate-400 line-through" : ""}><span className="text-xs text-slate-400">{fmtDateTime(h.createdAt)}</span> · {h.summary}{h.undone && " (dibatalkan)"}</li>)}</ul>
        </Card>
      )}
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
