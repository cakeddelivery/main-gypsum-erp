import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { productCosting, latestPrices, margin, CHANNELS } from "@/lib/hpp";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Card, Field, PageHeader, Stat } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProductForm } from "../ProductForm";
import { saveBom, savePrice } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Detail Produk" };

export default async function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("product.view");
  const { id } = await params;
  const p = await prisma.product.findUnique({ where: { id }, include: { bom: { include: { item: true } }, store: true } });
  if (!p) notFound();
  const [cost, prices, items, stores, finItems] = await Promise.all([
    productCosting(id),
    latestPrices(id),
    prisma.item.findMany({ where: { active: true }, orderBy: { sku: "asc" } }),
    prisma.store.findMany(),
    prisma.item.findMany({ where: { type: "BARANG_JADI" }, orderBy: { sku: "asc" } }),
  ]);
  const manage = user.can("product.manage");
  return (
    <div className="space-y-5">
      <PageHeader title={p.name} subtitle={`${p.sku} · ${p.type} · ${p.variant} · ${p.store.name} · isi ${p.packQty} pcs`} actions={<>{manage && <Modal trigger="Ubah produk" triggerClass="btn-secondary" title="Ubah produk"><ProductForm p={p} stores={stores} items={finItems} /></Modal>}</>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Biaya bahan (BOM)" value={idr(cost.material)} />
        <Stat label="Tenaga kerja" value={idr(cost.labor)} />
        <Stat label="Overhead" value={idr(cost.overhead)} />
        <Stat label="HPP / unit" value={idr(cost.hpp)} tone="blue" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Bill of Materials (BOM)" actions={manage && (
          <Modal trigger="Atur bahan" triggerClass="btn-primary btn-sm" title="Atur bahan BOM">
            <ModalForm action={saveBom} className="space-y-3">
              <input type="hidden" name="productId" value={p.id} />
              <Field label="Bahan"><select name="itemId" className="input">{items.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>)}</select></Field>
              <Field label="Qty per unit" hint="Isi 0 untuk menghapus bahan dari BOM"><input name="qty" inputMode="decimal" className="input" required /></Field>
              <Submit>Simpan</Submit>
            </ModalForm>
          </Modal>
        )}>
          <Paged><table className="tbl">
            <thead><tr><th>Bahan</th><th className="num">Qty/unit</th><th className="num">Harga rata²</th><th className="num">Biaya</th></tr></thead>
            <tbody>{p.bom.map((b) => <tr key={b.id}><td>{b.item.sku} — {b.item.name}</td><td className="num">{Number(b.qty)} {b.item.unit}</td><td className="num">{idr(b.item.avgCost)}</td><td className="num">{idr(Math.round(Number(b.qty) * Number(b.item.avgCost)))}</td></tr>)}</tbody>
          </table></Paged>
        </Card>
        <Card title="Harga & margin per kanal" actions={manage && (
          <Modal trigger="Ubah harga" triggerClass="btn-primary btn-sm" title="Harga baru">
            <ModalForm action={savePrice} className="space-y-3">
              <input type="hidden" name="productId" value={p.id} />
              <Field label="Kanal"><select name="channel" className="input">{CHANNELS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></Field>
              <Field label="Harga baru (IDR)"><input name="price" inputMode="numeric" className="input" required /></Field>
              <Submit>Simpan harga</Submit>
            </ModalForm>
          </Modal>
        )}>
          <Paged><table className="tbl">
            <thead><tr><th>Kanal</th><th className="num">Harga</th><th className="num">HPP kini</th><th className="num">Margin</th></tr></thead>
            <tbody>{CHANNELS.map((c) => { const pr = prices.latest.get(c); const m = pr ? margin(Number(pr.price), cost.hpp) : null; return <tr key={c}><td>{c.replace("_", " ")}</td><td className="num">{pr ? idr(pr.price) : "-"}</td><td className="num">{idr(cost.hpp)}</td><td className="num">{m ? <span className={m.value < 0 ? "text-rose-600" : "text-emerald-600"}>{idr(m.value)} ({m.pct}%)</span> : "-"}</td></tr>; })}</tbody>
          </table></Paged>
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
