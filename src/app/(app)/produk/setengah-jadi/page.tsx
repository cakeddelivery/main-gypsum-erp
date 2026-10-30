import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { itemCosts, recipeCosting } from "@/lib/hpp";
import { idr } from "@/lib/money";
import { BASE_UNITS, unitOptions } from "@/lib/itemCatalog";
import { fmtUnitPrice } from "@/lib/unitcost";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { TrendBadge } from "@/components/Trend";
import { ProdukTabs } from "../ProdukTabs";
import { saveSemi } from "../actions";
import { RecipeEditor, type RecipeInitial } from "../RecipeEditor";
import { recipeInitial, recipeOptions } from "../recipeData";
import type { Item } from "@prisma/client";

export const metadata = { title: "Barang Setengah Jadi" };

type Opts = Awaited<ReturnType<typeof recipeOptions>>;

function SemiForm({ item, opts, initial }: { item?: Item; opts: Opts; initial?: RecipeInitial }) {
  return (
    <ModalForm action={saveSemi} className="space-y-3">
      {item && <input type="hidden" name="id" value={item.id} />}
      <Field label="Kode Item"><input value={item?.sku ?? ""} placeholder="Otomatis terbuat (Cth: BSJ-001)" className="input bg-slate-100 dark:bg-slate-800" readOnly /></Field>
      <Field label="Nama Barang Setengah Jadi"><input name="name" defaultValue={item?.name} placeholder="Cth: Adonan Gypsum Super / Patung Mentah Unpainted" className="input" required /></Field>
      <Field label="Satuan"><select name="unit" defaultValue={item?.unit ?? "pcs"} className="input">{unitOptions(BASE_UNITS, item?.unit).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></Field>
      <Field label="Kategori Barang"><input value="Barang Setengah Jadi" className="input bg-slate-100 dark:bg-slate-800" readOnly /></Field>
      <RecipeEditor components={opts.components.filter((c) => c.id !== item?.id)} tasks={opts.tasks} overheads={opts.overheads} initial={initial} />
      <div className="grid grid-cols-2 gap-3">
        {!item && <Field label="Stok Awal" hint="Nilainya = HPP modal di atas"><input name="openingQty" inputMode="decimal" placeholder="0" className="input" /></Field>}
        <Field label="Catatan Keterangan" className={item ? "col-span-2" : ""}><input name="note" defaultValue={item?.note ?? ""} placeholder="Opsional (cth: Waktu kering 2 hari)" className="input" /></Field>
      </div>
      <Submit>Simpan Barang Setengah Jadi</Submit>
    </ModalForm>
  );
}

export default async function SetengahJadiPage() {
  const user = await requirePerm("product.view");
  const manage = user.can("product.manage");
  const [semis, costs] = await Promise.all([
    prisma.item.findMany({ where: { type: "BARANG_DALAM_PROSES", active: true }, orderBy: { name: "asc" } }),
    itemCosts(),
  ]);
  const [rows, opts] = await Promise.all([Promise.all(semis.map((s) => recipeCosting(s.id, costs))), recipeOptions(costs)]);
  return (
    <div className="space-y-5">
      <PageHeader title="Produk & HPP" subtitle="HPP modal barang setengah jadi = komponen (bahan baku / setengah jadi lain) + tenaga kerja borongan + overhead" actions={manage && (
        <Modal trigger="+ Barang Setengah Jadi" title="Tambah Barang Setengah Jadi" wide><SemiForm opts={opts} /></Modal>
      )} />
      <ProdukTabs current="bsj" />
      {rows.length === 0 ? <Empty title="Belum ada barang setengah jadi" hint="Klik + Barang Setengah Jadi untuk menyusun resepnya." /> : (
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          {rows.map((r) => {
            const hasRecipe = r.lines.length + r.item.recipeLabor.length + r.item.recipeOverhead.length > 0;
            const initial = recipeInitial(
              r.lines.map((l) => ({ componentId: l.component.id, qty: l.qty, useUnit: l.useUnit, unit: l.unit })),
              r.item.recipeLabor,
              r.item.recipeOverhead,
            );
            return (
              <Card key={r.item.id} title={`${r.item.name} · ${r.item.sku}`} actions={manage && (
                <Modal trigger={hasRecipe ? "Ubah" : "Atur Resep"} triggerClass="btn-secondary btn-sm" title={`Ubah ${r.item.name}`} wide><SemiForm item={r.item} opts={opts} initial={initial} /></Modal>
              )}>
                {!hasRecipe ? <p className="text-sm text-slate-500">Belum ada resep. HPP memakai harga beli/rata-rata: {idr(costs.get(r.item.id)?.cur ?? 0)}</p> : (
                  <>
                    <div className="overflow-x-auto"><table className="tbl">
                      <thead><tr><th>Komponen</th><th className="num">Pakai</th><th className="num">Harga</th><th className="num">Subtotal</th></tr></thead>
                      <tbody>
                        {r.lines.map((l) => {
                          const q = initial.comp.find((c) => c.itemId === l.component.id)!;
                          return <tr key={l.id}><td>{l.component.name}{l.fromRecipe && <div className="text-xs text-slate-400">setengah jadi</div>}</td><td className="num">{q.qty.toLocaleString("id-ID")} {q.useUnit}</td><td className="num">{fmtUnitPrice(l.unitPrice)}/{l.unit}</td><td className="num">{idr(Math.round(l.cost))}</td></tr>;
                        })}
                        {r.item.recipeLabor.map((l) => <tr key={l.id}><td colSpan={3}>Tenaga kerja: {l.name}</td><td className="num">{idr(l.rate)}</td></tr>)}
                        {r.item.recipeOverhead.map((o) => <tr key={o.id}><td colSpan={3}>Overhead: {o.overhead.name}{Number(o.factor) !== 1 && ` × ${Number(o.factor).toLocaleString("id-ID")}`}</td><td className="num">{idr(Math.round(r.overheadRows.get(o.id) ?? 0))}</td></tr>)}
                      </tbody>
                    </table></div>
                    <p className="mt-2 flex items-center justify-end gap-2 text-sm">HPP modal per {r.item.unit} <b className="text-base">{idr(r.hpp)}</b><TrendBadge t={r.trend} /></p>
                  </>
                )}
                {r.item.note && <p className="mt-1 text-xs text-slate-500">{r.item.note}</p>}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
