import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { channelPricing, feeConfig, itemCosts, productCosting, latestPrices, margin, CHANNELS } from "@/lib/hpp";
import { CHANNEL_LABEL } from "@/lib/pricing";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Card, Field, PageHeader, Stat } from "@/components/ui";
import { TrendBadge } from "@/components/Trend";
import { fmtUnitPrice } from "@/lib/unitcost";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { ProductForm } from "../ProductForm";
import { saveProductRecipe, savePrice } from "../actions";
import { RecipeEditor } from "../RecipeEditor";
import { recipeInitial, recipeOptions } from "../recipeData";

export const metadata = { title: "Detail Produk" };

export default async function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("product.view");
  const { id } = await params;
  const p = await prisma.product.findUnique({ where: { id }, include: { store: true, finishedItem: true } });
  if (!p) notFound();
  const costs = await itemCosts();
  const [cost, prices, stores, finItems, fees, opts] = await Promise.all([
    productCosting(id, costs),
    latestPrices(id),
    prisma.store.findMany(),
    prisma.item.findMany({ where: { type: "BARANG_JADI" }, orderBy: { name: "asc" } }),
    feeConfig(),
    recipeOptions(costs),
  ]);
  const initial = recipeInitial(
    cost.lines.map((l) => ({ componentId: l.item.id, qty: l.qty, useUnit: l.useUnit, unit: l.unit })),
    cost.recipeLabor,
    cost.recipeOverhead,
    { extraPackaging: p.extraPackaging, targetMargin: p.targetMargin },
  );
  const useQty = new Map(initial.comp.map((c) => [c.itemId, c]));
  const section = (title: string, rows: React.ReactNode[], total: number) => (
    <>
      <tr className="bg-slate-50 dark:bg-slate-800/50"><td colSpan={3} className="font-semibold">{title}</td><td className="num font-semibold">{idr(total)}</td></tr>
      {rows.length ? rows : <tr><td colSpan={4} className="text-xs text-slate-400">—</td></tr>}
    </>
  );
  const pricing = channelPricing(p, cost.hpp, fees, prices.latest);
  const manage = user.can("product.manage");
  return (
    <div className="space-y-5">
      <PageHeader title={p.name} subtitle={`${p.sku} · ${p.type} · ${p.variant} · ${p.store.name} · isi ${p.packQty} pcs`} actions={<>{manage && <Modal trigger="Ubah produk" triggerClass="btn-secondary" title="Ubah Master Produk Jadi"><ProductForm p={p} stores={stores} items={finItems} hpp={cost.hpp} minStock={p.finishedItem ? Number(p.finishedItem.minStock) : undefined} /></Modal>}</>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Bahan & setengah jadi" value={idr(cost.material)} hint={cost.bookMaterial !== cost.material + cost.packaging - Number(p.extraPackaging) ? `Nilai buku (harga rata-rata): ${idr(cost.bookMaterial)}` : undefined} />
        <Stat label="Packaging & kemasan" value={idr(cost.packaging)} />
        <Stat label="Tenaga kerja" value={idr(cost.labor)} />
        <Stat label="Overhead" value={idr(cost.overhead)} />
        <Stat label="HPP / unit (realtime)" value={idr(cost.hpp)} tone="blue" hint={<span className="flex items-center gap-2"><TrendBadge t={cost.trend} title="Dibanding HPP dengan harga beli sebelumnya" />{cost.trend.dir !== "TETAP" && <span className="text-xs text-slate-400">sebelumnya {idr(cost.prevHpp)}</span>}</span>} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card title="Resep HPP Produk" actions={manage && (
          <Modal trigger={cost.lines.length + cost.recipeLabor.length + cost.recipeOverhead.length ? "Ubah Resep HPP" : "Susun Resep HPP"} triggerClass="btn-primary btn-sm" title={`Penyusun Resep HPP · ${p.name}`} wide>
            <ModalForm action={saveProductRecipe} className="space-y-3">
              <input type="hidden" name="productId" value={p.id} />
              <RecipeEditor components={opts.components} tasks={opts.tasks} overheads={opts.overheads} initial={initial} product={{ fees, affiliatePct: Number(p.affiliatePct), adsPct: Number(p.adsPct), itemsPerOrder: Number(p.itemsPerOrder) || 1, legacy: cost.legacy }} />
              <Submit>Simpan Resep HPP Produk</Submit>
            </ModalForm>
          </Modal>
        )}>
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Komponen</th><th className="num">Pakai</th><th className="num">Harga terbaru</th><th className="num">Subtotal</th></tr></thead>
            <tbody>
              {section("1. Bahan baku & setengah jadi", cost.lines.filter((b) => !b.packaging).map((b) => { const u = useQty.get(b.item.id)!; return <tr key={b.id}><td>{b.item.name}{b.fromRecipe && <div className="text-xs text-slate-400">HPP dari resep setengah jadi</div>}</td><td className="num">{u.qty.toLocaleString("id-ID")} {u.useUnit}</td><td className="num">{fmtUnitPrice(b.unitPrice)}/{b.unit} <TrendBadge t={b.trend} /></td><td className="num">{idr(Math.round(b.cost))}</td></tr>; }), cost.material)}
              {section("2. Tenaga kerja borongan", cost.recipeLabor.map((l) => <tr key={l.id}><td colSpan={3}>{l.name}</td><td className="num">{idr(l.rate)}</td></tr>), cost.labor - Number(p.laborCost))}
              {section("3. Overhead produksi", cost.recipeOverhead.map((o) => <tr key={o.id}><td colSpan={3}>{o.overhead.name}{Number(o.factor) !== 1 && ` × ${Number(o.factor).toLocaleString("id-ID")}`}</td><td className="num">{idr(Math.round(cost.overheadRows.get(o.id) ?? 0))}</td></tr>), cost.overhead - Number(p.overheadCost))}
              {section("4. Packaging & kemasan", [...cost.lines.filter((b) => b.packaging).map((b) => { const u = useQty.get(b.item.id)!; return <tr key={b.id}><td>{b.item.name}</td><td className="num">{u.qty.toLocaleString("id-ID")} {u.useUnit}</td><td className="num">{fmtUnitPrice(b.unitPrice)}/{b.unit}</td><td className="num">{idr(Math.round(b.cost))}</td></tr>; }), ...(Number(p.extraPackaging) ? [<tr key="extra"><td colSpan={3}>Tambahan biaya kemasan lainnya</td><td className="num">{idr(p.extraPackaging)}</td></tr>] : [])], cost.packaging)}
              {cost.legacy > 0 && <tr><td colSpan={3} className="text-amber-700">Biaya manual lama (hilang saat resep disimpan)</td><td className="num">{idr(cost.legacy)}</td></tr>}
              <tr><td colSpan={3} className="font-bold">Total HPP modal / pcs</td><td className="num font-bold">{idr(cost.hpp)}</td></tr>
            </tbody>
          </table></div>
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
