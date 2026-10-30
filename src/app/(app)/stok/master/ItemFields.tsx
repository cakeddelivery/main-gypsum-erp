"use client";
import { useState } from "react";
import type { ItemType } from "@prisma/client";
import { Field } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { BASE_UNITS, ITEM_CATEGORIES, PURCHASE_UNITS, normalizeUnit, unitOptions } from "@/lib/itemCatalog";
import { fmtUnitPrice } from "@/lib/unitcost";

type Opt = { id: string; name: string };
export type ItemInit = {
  id: string; sku: string; name: string; type: ItemType; category: string | null; unit: string; hppUnit: string | null; hppFactor: number;
  minStock: number; supplierId: string | null; divisionId: string | null; gypsumCharacterId: string | null; note: string | null; active: boolean; lastCost: number;
};

const TYPE_LABEL: Record<ItemType, string> = { BAHAN_BAKU: "Bahan baku", BARANG_DALAM_PROSES: "Setengah jadi", BARANG_JADI: "Produk jadi" };
const num = (s: string) => Number(s.replace(/\./g, "").replace(",", ".")) || 0;

/** Form master item: kategori + kode otomatis, satuan beli ↔ satuan dasar HPP, stok awal & reorder point */
export function ItemFields({ i, suppliers, divisions, gypsum }: { i?: ItemInit; suppliers: Opt[]; divisions: Opt[]; gypsum: Opt[] }) {
  const [type, setType] = useState<ItemType>(i?.type ?? "BAHAN_BAKU");
  const [category, setCategory] = useState(i?.category ?? ITEM_CATEGORIES[i?.type ?? "BAHAN_BAKU"][0].name);
  const [unit, setUnit] = useState(normalizeUnit(PURCHASE_UNITS, i?.unit) || "sak");
  const [baseUnit, setBaseUnit] = useState(normalizeUnit(BASE_UNITS, i?.hppUnit) || (i ? "" : "kg"));
  const [factor, setFactor] = useState(i ? String(i.hppFactor).replace(".", ",") : "1");
  const [price, setPrice] = useState(i?.lastCost ? String(i.lastCost) : "");
  const [newSupplier, setNewSupplier] = useState(false);
  const cats = ITEM_CATEGORIES[type];
  const same = !baseUnit || baseUnit === unit;
  const f = same ? 1 : num(factor);
  const perBase = f > 0 ? num(price) / f : 0;
  const unitLabel = (v: string) => [...PURCHASE_UNITS, ...BASE_UNITS].find((u) => u.value === v)?.label.split(" (")[0] ?? v;
  const raw = type === "BAHAN_BAKU";
  return (
    <div className="grid grid-cols-2 gap-3">
      {i && <input type="hidden" name="id" value={i.id} />}
      <Field label="Jenis item" className="col-span-2">
        <select name="type" value={type} className="input" onChange={(e) => { const t = e.target.value as ItemType; setType(t); setCategory(ITEM_CATEGORIES[t][0].name); if (!i) { setUnit(t === "BAHAN_BAKU" ? "sak" : "pcs"); setBaseUnit(t === "BAHAN_BAKU" ? "kg" : ""); } }}>
          {(Object.keys(TYPE_LABEL) as ItemType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      <Field label="Kategori" className="col-span-2"><select name="category" value={category} onChange={(e) => setCategory(e.target.value)} className="input">{cats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></Field>
      {/* Kode item dibuat otomatis per kategori dan tidak ditampilkan (permintaan owner) */}
      {i && <input type="hidden" name="sku" value={i.sku} />}
      <Field label="Nama item" className="col-span-2"><input name="name" defaultValue={i?.name} className="input" placeholder={raw ? "cth: Bubuk Gypsum Super Casting" : "cth: Patung Mentah Dinosaurus"} required /></Field>
      <Field label="Supplier / pemasok" className="col-span-2">
        {newSupplier ? (
          <div className="flex gap-2">
            <input name="newSupplierName" className="input" placeholder="Nama supplier baru" required autoFocus />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewSupplier(false)}>Batal</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <div className="min-w-0 flex-1"><select name="supplierId" defaultValue={i?.supplierId ?? ""} className="input"><option value="">— tanpa supplier —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setNewSupplier(true)}>+ Baru</button>
          </div>
        )}
      </Field>

      <div className="col-span-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-800">Satuan beli & satuan dasar (resep HPP)</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Satuan beli"><select name="unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="input">{unitOptions(PURCHASE_UNITS, unit).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></Field>
          <Field label="Satuan dasar (resep HPP)">
            <select name="hppUnit" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} className="input">
              <option value="">Sama dengan satuan beli</option>
              {unitOptions(BASE_UNITS, baseUnit).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </Field>
          {!same && <Field label={`Isi 1 ${unitLabel(unit)} = … ${unitLabel(baseUnit)}`}><input name="hppFactor" value={factor} onChange={(e) => setFactor(e.target.value)} inputMode="decimal" className="input" required /></Field>}
          {same && <input type="hidden" name="hppFactor" value="1" />}
          {i ? (
            <Field label={`Harga beli terbaru / ${unitLabel(unit)}`} hint="Berubah otomatis dari pembelian"><input value={i.lastCost.toLocaleString("id-ID")} className="input" disabled /></Field>
          ) : (
            <Field label={`Harga beli / ${unitLabel(unit)} (Rp)`}><input name="price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" className="input" placeholder="cth: 72000" /></Field>
          )}
        </div>
        <p className="mt-2 flex items-center justify-between gap-2 border-t border-emerald-200 pt-2 text-sm">
          <span className="text-slate-600">Harga per satuan dasar</span>
          <b className="text-emerald-700">{fmtUnitPrice(perBase)} / {unitLabel(same ? unit : baseUnit)}</b>
        </p>
      </div>

      {!i && <Field label={`Stok awal (${unitLabel(unit)})`}><input name="openingQty" inputMode="decimal" className="input" defaultValue="0" /></Field>}
      <Field label="Batas minimum stok (reorder)" hint="Muncul di daftar reorder bila stok ≤ angka ini"><input name="minStock" defaultValue={i ? i.minStock : 10} inputMode="decimal" className="input" /></Field>
      {raw && <Field label="Divisi pemakai" hint="Divisi yang memakai & menghitung stoknya"><select name="divisionId" defaultValue={i?.divisionId ?? ""} className="input"><option value="">—</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
      {raw && <Field label="Karakter gypsum"><select name="gypsumCharacterId" defaultValue={i?.gypsumCharacterId ?? ""} className="input"><option value="">—</option>{gypsum.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <Field label="Catatan" className="col-span-2"><input name="note" defaultValue={i?.note ?? ""} className="input" placeholder="Opsional (cth: kemasan sak 40 kg)" /></Field>
      {i && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={i.active} /> Aktif</label>}
      <div className="col-span-2 flex justify-end"><Submit>Simpan item</Submit></div>
    </div>
  );
}
