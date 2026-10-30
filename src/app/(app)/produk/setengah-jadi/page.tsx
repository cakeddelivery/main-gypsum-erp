import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { itemCosts, overheadSummary, recipeCosting } from "@/lib/hpp";
import { idr } from "@/lib/money";
import { fmtUnitPrice, recipeUnit } from "@/lib/unitcost";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ItemLines } from "@/components/ItemLines";
import { TrendBadge } from "@/components/Trend";
import { ProdukTabs } from "../ProdukTabs";
import { saveRecipe } from "../actions";

export const metadata = { title: "Barang Setengah Jadi" };

export default async function SetengahJadiPage() {
  const user = await requirePerm("product.view");
  const manage = user.can("product.manage");
  const [semis, components, costs, oh] = await Promise.all([
    prisma.item.findMany({ where: { type: "BARANG_DALAM_PROSES", active: true }, orderBy: { name: "asc" } }),
    prisma.item.findMany({ where: { active: true, type: { in: ["BAHAN_BAKU", "BARANG_DALAM_PROSES"] } }, orderBy: { name: "asc" } }),
    itemCosts(),
    overheadSummary(),
  ]);
  const rows = await Promise.all(semis.map((s) => recipeCosting(s.id, costs)));
  return (
    <div className="space-y-5">
      <PageHeader title="Produk & HPP" subtitle="HPP modal barang setengah jadi = komponen (bahan baku / setengah jadi lain) + upah + overhead per unit" />
      <ProdukTabs current="bsj" />
      {rows.length === 0 ? <Empty title="Belum ada barang setengah jadi" hint="Tambahkan di Stok › Master Item dengan jenis Barang Setengah Jadi." /> : (
        <div className="grid gap-5 lg:grid-cols-2">
          {rows.map((r) => (
            <Card key={r.item.id} title={r.item.name} actions={manage && (
              <Modal trigger={r.lines.length ? "Ubah Resep" : "Atur Resep"} triggerClass="btn-secondary btn-sm" title={`Resep ${r.item.name} per 1 ${r.item.unit}`} wide>
                <ModalForm action={saveRecipe} className="space-y-3">
                  <input type="hidden" name="itemId" value={r.item.id} />
                  <div>
                    <span className="label">Komponen per 1 {r.item.unit}</span>
                    <ItemLines name="componentId" items={components.filter((c) => c.id !== r.item.id).map((c) => ({ id: c.id, name: c.name, unit: recipeUnit(c) }))} initial={r.lines.map((l) => ({ itemId: l.component.id, qty: l.qty }))} qtyLabel="Qty" emptyLabel="— pilih bahan / setengah jadi —" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={`Upah per ${r.item.unit} (Rp)`} hint="Mis. tarif borongan cat giftbox"><input name="laborCost" inputMode="numeric" defaultValue={r.labor} className="input" /></Field>
                    <Field label={`Overhead per ${r.item.unit} (Rp)`} hint={oh.perPcs ? `Overhead master: ${idr(oh.perPcs)}/pcs` : "Atur di tab Overhead"}><input name="overheadCost" inputMode="numeric" defaultValue={r.overhead} className="input" /></Field>
                  </div>
                  <p className="text-xs text-slate-500">Isi overhead di salah satu tingkat saja (setengah jadi atau produk jadi) supaya tidak terhitung dua kali.</p>
                  <Submit>Simpan Resep</Submit>
                </ModalForm>
              </Modal>
            )}>
              {r.lines.length === 0 ? <p className="text-sm text-slate-500">Belum ada resep. HPP memakai harga beli/rata-rata: {idr(costs.get(r.item.id)?.cur ?? 0)}</p> : (
                <>
                  <table className="tbl">
                    <thead><tr><th>Komponen</th><th className="num">Qty</th><th className="num">Harga</th><th className="num">Biaya</th></tr></thead>
                    <tbody>
                      {r.lines.map((l) => <tr key={l.id}><td>{l.component.name}{l.fromRecipe && <div className="text-xs text-slate-400">dari resep</div>}</td><td className="num">{l.qty.toLocaleString("id-ID")} {l.unit}</td><td className="num">{fmtUnitPrice(l.unitPrice)}/{l.unit}</td><td className="num">{idr(Math.round(l.cost))}</td></tr>)}
                      <tr><td colSpan={3}>Upah</td><td className="num">{idr(r.labor)}</td></tr>
                      <tr><td colSpan={3}>Overhead</td><td className="num">{idr(r.overhead)}</td></tr>
                    </tbody>
                  </table>
                  <p className="mt-2 flex items-center justify-end gap-2 text-sm">HPP modal per {r.item.unit} <b className="text-base">{idr(r.hpp)}</b><TrendBadge t={r.trend} /></p>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
