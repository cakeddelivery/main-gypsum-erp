import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { ITEM_CATEGORIES } from "@/lib/itemCatalog";
import { saveProduct } from "./actions";
import type { Product } from "@prisma/client";

const TYPES = { SATUAN: "Satuan", PAKET_12: "Paket 12", PAKET_24: "Paket 24", PAKET_48: "Paket 48", GIFTBOX: "Giftbox", CUSTOM: "Custom" };
const ro = "input bg-slate-100 dark:bg-slate-800";

/** Master produk jadi (susunan mengikuti form referensi owner); resep HPP diatur di halaman detail */
export function ProductForm({ p, stores, items, hpp, minStock }: { p?: Product; stores: { id: string; name: string }[]; items: { id: string; sku: string; name: string }[]; hpp?: number; minStock?: number }) {
  return (
    <ModalForm action={saveProduct} className="grid grid-cols-2 gap-3">
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Kode Produk Jadi" className="col-span-2" hint={p ? undefined : "Kode dibuat otomatis berdasarkan kategori & nomor urut."}>
        <input name="sku" defaultValue={p?.sku} placeholder="Otomatis terbuat (Cth: MG-001)" className={p ? "input" : ro} readOnly={!p} />
      </Field>
      <Field label="Nama Produk Mainan" className="col-span-2"><input name="name" defaultValue={p?.name} placeholder="Cth: Patung Gypsum Dinosaurus Set" className="input" required /></Field>
      <Field label="Kategori Produk" className="col-span-2"><select name="category" defaultValue={p?.category ?? "Mainan Gypsum"} className="input">{ITEM_CATEGORIES.BARANG_JADI.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></Field>
      <Field label="Tipe"><select name="type" defaultValue={p?.type} className="input">{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Varian"><select name="variant" defaultValue={p?.variant} className="input">{["COWOK", "CEWEK", "HEWAN", "TRANSPORTASI", "MIX"].map((v) => <option key={v} value={v}>{v}</option>)}</select></Field>
      {p ? (
        <Field label="Estimasi HPP / Pcs (Rp)" hint="Dari Resep HPP"><input value={hpp ?? 0} className={ro} readOnly /></Field>
      ) : (
        <Field label="Estimasi HPP / Pcs (Rp)" hint="Nilai stok awal; nanti dihitung dari resep"><input name="estimatedHpp" inputMode="numeric" placeholder="0" className="input" /></Field>
      )}
      {p ? <Field label="Isi per kemasan (pcs)"><input name="packQty" defaultValue={p.packQty} inputMode="numeric" className="input" /></Field> : <Field label="Harga Jual / Pcs (Rp)" hint="Harga toko offline"><input name="price" inputMode="numeric" placeholder="Cth: 15000" className="input" /></Field>}
      {!p && <Field label="Stok Awal (Pcs)"><input name="openingQty" inputMode="decimal" placeholder="0" className="input" /></Field>}
      <Field label="Batas Minim Stok (Pcs)" className={p ? "col-span-2" : ""}><input name="minStock" defaultValue={minStock ?? 10} inputMode="decimal" className="input" /></Field>
      <Field label="Catatan" className="col-span-2"><input name="note" defaultValue={p?.note ?? ""} placeholder="Opsional (cth: Paket 4 patung + 6 cat)" className="input" /></Field>
      <details className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <summary className="cursor-pointer text-sm font-medium">Pengaturan toko & marketplace</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Toko" className="col-span-2"><select name="storeId" defaultValue={p?.storeId} className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Affiliate (%)" hint="Opsional, marketplace"><input name="affiliatePct" defaultValue={p ? Number(p.affiliatePct) : 0} inputMode="decimal" className="input" /></Field>
          <Field label="Iklan (%)" hint="Marketplace"><input name="adsPct" defaultValue={p ? Number(p.adsPct) : 0} inputMode="decimal" className="input" /></Field>
          <Field label="Rata-rata produk / pesanan" className="col-span-2" hint="Membagi biaya pesanan flat Rp1.250"><input name="itemsPerOrder" defaultValue={p ? Number(p.itemsPerOrder) : 1} inputMode="decimal" className="input" /></Field>
          {p && <Field label="Item stok barang jadi" className="col-span-2"><select name="finishedItemId" defaultValue={p.finishedItemId ?? ""} className="input"><option value="">—</option>{items.map((i) => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}</select></Field>}
        </div>
      </details>
      {p && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={p.active} /> Aktif</label>}
      <div className="col-span-2"><Submit>Simpan Produk</Submit></div>
    </ModalForm>
  );
}
