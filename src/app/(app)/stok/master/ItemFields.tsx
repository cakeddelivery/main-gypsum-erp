"use client";
import { useState } from "react";
import type { ItemType } from "@prisma/client";
import { Field } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { BASE_UNITS, PURCHASE_UNITS, normalizeUnit, unitOptions } from "@/lib/itemCatalog";
import type { CategoryMap } from "@/lib/itemCategories";
import { fmtUnitPrice } from "@/lib/unitcost";

type Opt = { id: string; name: string };
export type ItemInit = {
  id: string; sku: string; name: string; type: ItemType; category: string | null; unit: string; hppUnit: string | null; hppFactor: number;
  minStock: number; supplierId: string | null; divisionId: string | null; note: string | null; active: boolean; lastCost: number;
  buyPrice: number; buyQty: number; buyMode: "OFFLINE" | "ONLINE"; productUrl: string | null; orderQty: number; manualNote: string | null;
};

const TYPE_LABEL: Record<ItemType, string> = { BAHAN_BAKU: "Bahan baku", BARANG_DALAM_PROSES: "Setengah jadi", BARANG_JADI: "Produk jadi" };
const num = (s: string) => Number(s.replace(/\./g, "").replace(",", ".")) || 0;

/** Form master item: kategori + kode otomatis, satuan beli ↔ satuan dasar HPP, stok awal & reorder point */
export function ItemFields({ i, suppliers, divisions, categories: ITEM_CATEGORIES, canEditCost }: { i?: ItemInit; suppliers: Opt[]; divisions: Opt[]; categories: CategoryMap; canEditCost?: boolean }) {
  const [type, setType] = useState<ItemType>(i?.type ?? "BAHAN_BAKU");
  const [category, setCategory] = useState(i?.category ?? ITEM_CATEGORIES[i?.type ?? "BAHAN_BAKU"][0].name);
  const [unit, setUnit] = useState(normalizeUnit(PURCHASE_UNITS, i?.unit) || "sak");
  const [baseUnit, setBaseUnit] = useState(normalizeUnit(BASE_UNITS, i?.hppUnit) || (i ? "" : "kg"));
  const [factor, setFactor] = useState(i ? String(i.hppFactor).replace(".", ",") : "1");
  // Harga pembelian (total Rp) + quantity (satuan beli); item lama tanpa data pembelian memakai harga per satuan × 1
  const [price, setPrice] = useState(i ? String(i.buyPrice || i.lastCost || "") : "");
  const [qty, setQty] = useState(i ? String(i.buyPrice ? i.buyQty : 1).replace(".", ",") : "1");
  const [mode, setMode] = useState<"OFFLINE" | "ONLINE">(i?.buyMode ?? "OFFLINE");
  const [newSupplier, setNewSupplier] = useState(false);
  // Kategori lama yang sudah dinonaktifkan tetap tampil untuk item yang masih memakainya
  const cats = i?.category && i.type === type && !ITEM_CATEGORIES[type].some((c) => c.name === i.category) ? [...ITEM_CATEGORIES[type], { name: i.category, prefix: "" }] : ITEM_CATEGORIES[type];
  const same = !baseUnit || baseUnit === unit;
  const f = same ? 1 : num(factor);
  const editable = !i || !!canEditCost;
  const perBuy = num(qty) > 0 ? num(price) / num(qty) : 0;
  const perBase = f > 0 ? perBuy / f : 0;
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
          {!same && <Field label={`1 ${unitLabel(unit)} = berapa ${unitLabel(baseUnit)}?`} hint="Konversi otomatis ke satuan dasar"><input name="hppFactor" value={factor} onChange={(e) => setFactor(e.target.value)} inputMode="decimal" className="input" required /></Field>}
          {same && <input type="hidden" name="hppFactor" value="1" />}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-emerald-200 pt-3">
          <Field label="Harga pembelian (Rp)" hint={editable ? "Total yang dibayar" : "Berubah otomatis dari pembelian"}>
            <input name={editable ? "buyPrice" : undefined} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" className="input" placeholder="cth: 720000" disabled={!editable} />
          </Field>
          <Field label={`Quantity (${unitLabel(unit)})`} hint="Jumlah yang dibeli dengan harga itu">
            <input name={editable ? "buyQty" : undefined} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="input" placeholder="cth: 10" disabled={!editable} />
          </Field>
        </div>
        {i?.manualNote && <p className="mt-1 text-xs text-amber-700">{i.manualNote}. Pembelian berikutnya akan memperbarui harga otomatis.</p>}
        {i && canEditCost && !i.manualNote && <p className="mt-1 text-xs text-slate-500">Owner boleh mengisi manual (tercatat di audit); pembelian berikutnya tetap memperbarui harga otomatis.</p>}
        <div className="mt-2 space-y-1 border-t border-emerald-200 pt-2 text-sm">
          <p className="flex items-center justify-between gap-2"><span className="text-slate-600">Harga per satuan beli</span><b className="text-emerald-700">{fmtUnitPrice(perBuy)} / {unitLabel(unit)}</b></p>
          {!same && <p className="flex items-center justify-between gap-2"><span className="text-slate-600">Harga per satuan dasar</span><b className="text-emerald-700">{fmtUnitPrice(perBase)} / {unitLabel(baseUnit)}</b></p>}
        </div>
      </div>

      <Field label="Tipe pembelian" className="col-span-2">
        <input type="hidden" name="buyMode" value={mode} />
        <div className="grid grid-cols-2 gap-2">
          {(["OFFLINE", "ONLINE"] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={mode === m ? "btn-primary btn-sm" : "btn-secondary btn-sm"} aria-pressed={mode === m}>{m === "OFFLINE" ? "OFFLINE (toko/supplier)" : "ONLINE (link produk)"}</button>)}
        </div>
      </Field>
      {mode === "ONLINE" && <Field label="Link Produk" className="col-span-2" hint="Supervisor order lewat link ini"><input name="productUrl" type="url" defaultValue={i?.productUrl ?? ""} className="input" placeholder="https://shopee.co.id/…" required data-raw /></Field>}

      {!i && <Field label={`Stok awal (${unitLabel(unit)})`}><input name="openingQty" inputMode="decimal" className="input" defaultValue="0" /></Field>}
      <Field label="Batas minimum stok (reorder)" hint="Muncul di daftar reorder bila stok ≤ angka ini"><input name="minStock" defaultValue={i ? i.minStock : 10} inputMode="decimal" className="input" /></Field>
      {<Field label={raw ? "Divisi pemakai" : "Divisi penanggung jawab"} hint={raw ? "Divisi yang memakai & menghitung stoknya" : "Divisi yang menghitung stok akhirnya di laporan shift"}><select name="divisionId" defaultValue={i?.divisionId ?? ""} className="input"><option value="">—</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
      {raw && <Field label={`Jumlah order biasa (${unitLabel(unit)})`} hint="Untuk permintaan stok otomatis: kekurangan s/d batas + jumlah ini"><input name="orderQty" defaultValue={i ? i.orderQty : 0} inputMode="decimal" className="input" /></Field>}
      <Field label="Catatan" className="col-span-2"><input name="note" defaultValue={i?.note ?? ""} className="input" placeholder="Opsional (cth: kemasan sak 40 kg)" /></Field>
      {i && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={i.active} /> Aktif</label>}
      <div className="col-span-2 flex justify-end"><Submit>Simpan item</Submit></div>
    </div>
  );
}
