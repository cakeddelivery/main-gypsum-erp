import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { saveProduct } from "./actions";
import type { Product } from "@prisma/client";

const TYPES = { SATUAN: "Satuan", PAKET_12: "Paket 12", PAKET_24: "Paket 24", PAKET_48: "Paket 48", GIFTBOX: "Giftbox", CUSTOM: "Custom" };

export function ProductForm({ p, stores, items }: { p?: Product; stores: { id: string; name: string }[]; items: { id: string; sku: string; name: string }[] }) {
  return (
    <ModalForm action={saveProduct} className="grid grid-cols-2 gap-3">
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="SKU"><input name="sku" defaultValue={p?.sku} className="input" required /></Field>
      <Field label="Toko"><select name="storeId" defaultValue={p?.storeId} className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Nama" className="col-span-2"><input name="name" defaultValue={p?.name} className="input" required /></Field>
      <Field label="Tipe"><select name="type" defaultValue={p?.type} className="input">{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Varian"><select name="variant" defaultValue={p?.variant} className="input">{["COWOK", "CEWEK", "HEWAN", "TRANSPORTASI", "MIX"].map((v) => <option key={v} value={v}>{v}</option>)}</select></Field>
      <Field label="Isi per kemasan (pcs)"><input name="packQty" defaultValue={p?.packQty} inputMode="numeric" className="input" placeholder="otomatis dari tipe" /></Field>
      <Field label="Item barang jadi (stok)"><select name="finishedItemId" defaultValue={p?.finishedItemId ?? ""} className="input"><option value="">—</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
      <Field label="Biaya tenaga kerja / unit"><input name="laborCost" defaultValue={p ? Number(p.laborCost) : 0} inputMode="numeric" className="input" /></Field>
      <Field label="Overhead / unit"><input name="overheadCost" defaultValue={p ? Number(p.overheadCost) : 0} inputMode="numeric" className="input" /></Field>
      {p && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={p.active} /> Aktif</label>}
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
}
