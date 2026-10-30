import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { channelPricing, feeConfig, overheadSummary, productCosting, latestPrices, margin, CHANNELS } from "@/lib/hpp";
import { CHANNEL_LABEL } from "@/lib/pricing";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Card, Field, PageHeader, Stat } from "@/components/ui";
import { TrendBadge } from "@/components/Trend";
import { fmtUnitPrice, recipeUnit } from "@/lib/unitcost";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { ProductForm } from "../ProductForm";
import { saveBom, savePrice } from "../actions";

export const metadata = { title: "Detail Produk" };

export default async function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("product.view");
  const { id } = await params;
  const p = await prisma.product.findUnique({ where: { id }, include: { bom: { include: { item: true } }, store: true } });
  if (!p) notFound();
  const [cost, prices, items, stores, finItems, fees, oh] = await Promise.all([
    productCosting(id),
    latestPrices(id),
    prisma.item.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.store.findMany(),
    prisma.item.findMany({ where: { type: "BARANG_JADI" }, orderBy: { name: "asc" } }),
    feeConfig(),
    overheadSummary(),
  ]);
  const pricing = channelPricing(p, cost.hpp, fees, prices.latest);
  const manage = user.can("product.manage");
  return (
    <div className="space-y-5">
      <PageHeader title={p.name} subtitle={`${p.sku} · ${p.type} · ${p.variant} · ${p.store.name} · isi ${p.packQty} pcs`} actions={<>{manage && <Modal trigger="Ubah produk" triggerClass="btn-secondary" title="Ubah produk"><ProductForm p={p} stores={stores} items={finItems} overheadPerPcs={oh.perPcs} /></Modal>}</>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Biaya bahan (harga beli terbaru)" value={idr(cost.material)} hint={cost.bookMaterial !== cost.material ? `Nilai buku (harga rata-rata): ${idr(cost.bookMaterial)}` : undefined} />
        <Stat label="Tenaga kerja" value={idr(cost.labor)} />
        <Stat label="Overhead" value={idr(cost.overhead)} />
        <Stat label="HPP / unit (realtime)" value={idr(cost.hpp)} tone="blue" hint={<span className="flex items-center gap-2"><TrendBadge t={cost.trend} title="Dibanding HPP dengan harga beli sebelumnya" />{cost.trend.dir !== "TETAP" && <span className="text-xs text-slate-400">sebelumnya {idr(cost.prevHpp)}</span>}</span>} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Bill of Materials (BOM)" actions={manage && (
          <Modal trigger="Atur bahan" triggerClass="btn-primary btn-sm" title="Atur bahan BOM">
            <ModalForm action={saveBom} className="space-y-3">
              <input type="hidden" name="productId" value={p.id} />
              <Field label="Bahan"><select name="itemId" className="input">{items.map((i) => <option key={i.id} value={i.id}>{i.name} ({recipeUnit(i)})</option>)}</select></Field>
              <Field label="Qty per unit, dalam satuan resep" hint="Isi 0 untuk menghapus bahan dari BOM"><input name="qty" inputMode="decimal" className="input" required /></Field>
              <Submit>Simpan</Submit>
            </ModalForm>
          </Modal>
        )}>
          <Paged><table className="tbl">
            <thead><tr><th>Bahan</th><th className="num">Qty/unit</th><th className="num">Harga terbaru</th><th>Tren</th><th className="num">Biaya</th></tr></thead>
            <tbody>{cost.lines.map((b) => <tr key={b.id}><td>{b.item.name}{b.fromRecipe && <div className="text-xs text-slate-400">HPP dari resep setengah jadi</div>}{b.unit !== b.item.unit && <div className="text-xs text-slate-400">1 {b.item.unit} = {Number(b.item.hppFactor).toLocaleString("id-ID")} {b.unit}</div>}</td><td className="num">{b.qty.toLocaleString("id-ID")} {b.unit}</td><td className="num">{fmtUnitPrice(b.unitPrice)}/{b.unit}</td><td><TrendBadge t={b.trend} /></td><td className="num">{idr(Math.round(b.cost))}</td></tr>)}</tbody>
          </table></Paged>
        </Card>
        <Card title={`Harga & laba per kanal · target margin ${Number(p.targetMargin)}%`} actions={manage && (
          <Modal trigger="Ubah harga" triggerClass="btn-primary btn-sm" title="Harga baru">
            <ModalForm action={savePrice} className="space-y-3">
              <input type="hidden" name="productId" value={p.id} />
              <Field label="Kanal"><select name="channel" className="input">{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select></Field>
              <Field label="Harga baru (IDR)"><input name="price" inputMode="numeric" className="input" required /></Field>
              <Submit>Simpan harga</Submit>
            </ModalForm>
          </Modal>
        )}>
          <div className="space-y-3">
            {pricing.map((c) => (
              <div key={c.channel} className="rounded-xl border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b>{CHANNEL_LABEL[c.channel]}</b>
                  <span>Harga sekarang <b>{c.current ? idr(c.current.price) : "-"}</b>{c.current && <span className={`ml-2 ${c.current.profit < 0 ? "text-rose-600" : "text-emerald-600"}`}>laba {idr(c.current.profit)} ({c.current.pct}%)</span>}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-slate-600">
                  <span>Saran harga <b className="text-slate-900">{c.suggested ? idr(c.suggested) : "tidak tercapai"}</b>{c.suggestedBreakdown && (c.suggestedBreakdown.fees + c.suggestedBreakdown.flat + c.suggestedBreakdown.affiliate + c.suggestedBreakdown.ads > 0) && <span className="block text-xs">potongan {idr(c.suggestedBreakdown.fees)}{c.suggestedBreakdown.flat ? ` + pesanan ${idr(c.suggestedBreakdown.flat)}` : ""}{c.suggestedBreakdown.affiliate ? ` + affiliate ${idr(c.suggestedBreakdown.affiliate)}` : ""}{c.suggestedBreakdown.ads ? ` + iklan ${idr(c.suggestedBreakdown.ads)}` : ""} · laba {idr(c.suggestedBreakdown.profit)}</span>}</span>
                  {manage && c.suggested && c.suggested !== c.current?.price && (
                    <ActionForm action={savePrice} confirm={`Pakai harga ${idr(c.suggested)} untuk ${CHANNEL_LABEL[c.channel]}?`}>
                      <input type="hidden" name="productId" value={p.id} /><input type="hidden" name="channel" value={c.channel} /><input type="hidden" name="price" value={c.suggested} />
                      <Submit className="btn-success btn-sm" pendingText="…">Pakai</Submit>
                    </ActionForm>
                  )}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-500">Laba = harga − potongan marketplace − biaya pesanan per produk − affiliate − iklan − HPP. Affiliate & iklan hanya untuk marketplace.</p>
          </div>
        </Card>
      </div>
      <Card title="Histori harga, biaya & margin">
        <div className="overflow-x-auto">
          <Paged><table className="tbl">
            <thead><tr><th>Waktu</th><th>Kanal</th><th className="num">Harga</th><th className="num">HPP saat itu</th><th className="num">Margin</th><th>Oleh</th></tr></thead>
            <tbody>{prices.history.map((h) => { const m = margin(Number(h.price), Number(h.hpp)); return <tr key={h.id}><td>{fmtDateTime(h.effectiveAt)}</td><td>{h.channel}</td><td className="num">{idr(h.price)}</td><td className="num">{Number(h.hpp) ? idr(h.hpp) : "-"}</td><td className="num">{Number(h.hpp) ? `${m.pct}%` : "-"}</td><td>{h.createdBy}</td></tr>; })}</tbody>
          </table></Paged>
        </div>
      </Card>
    </div>
  );
}
