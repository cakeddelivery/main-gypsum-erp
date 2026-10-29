import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ITEM_TYPE_LABEL } from "@/lib/stock";
import { idr } from "@/lib/money";
import { Badge, Field, PageHeader, Tabs } from "@/components/ui";
import { TrendBadge } from "@/components/Trend";
import { costPerRecipeUnit, fmtUnitPrice, latestCost, previousCost, recipeUnit, trendOf } from "@/lib/unitcost";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { saveGypsum, saveItem, saveLocation, saveSupplier } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Master Stok" };

export default async function MasterPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requirePerm("master.manage");
  const { tab = "item" } = await searchParams;
  const [items, suppliers, locations, gypsum, divisions] = await Promise.all([
    prisma.item.findMany({ include: { supplier: true, gypsumCharacter: true }, orderBy: { sku: "asc" } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } }),
    prisma.location.findMany({ include: { division: true }, orderBy: { code: "asc" } }),
    prisma.gypsumCharacter.findMany({ orderBy: { name: "asc" } }),
    prisma.division.findMany({ orderBy: { code: "asc" } }),
  ]);
  const itemForm = (i?: (typeof items)[number]) => (
    <ModalForm action={saveItem} className="grid grid-cols-2 gap-3">
      {i && <input type="hidden" name="id" value={i.id} />}
      <Field label="SKU"><input name="sku" defaultValue={i?.sku} className="input" required /></Field>
      <Field label="Satuan"><input name="unit" defaultValue={i?.unit ?? "pcs"} className="input" /></Field>
      <Field label="Nama" className="col-span-2"><input name="name" defaultValue={i?.name} className="input" required /></Field>
      <Field label="Jenis"><select name="type" defaultValue={i?.type} className="input">{Object.entries(ITEM_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Satuan resep/HPP (opsional)" hint="mis. gram, bila resep tidak memakai satuan stok"><input name="hppUnit" defaultValue={i?.hppUnit ?? ""} placeholder="sama dengan satuan" className="input" /></Field>
      <Field label="Isi 1 satuan stok" hint="mis. 1 sak = 18000 gram"><input name="hppFactor" defaultValue={i ? Number(i.hppFactor) : 1} inputMode="decimal" className="input" /></Field>
      <Field label="Stok minimum"><input name="minStock" defaultValue={i ? Number(i.minStock) : 0} inputMode="decimal" className="input" /></Field>
      <Field label="Supplier"><select name="supplierId" defaultValue={i?.supplierId ?? ""} className="input"><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Karakter gypsum"><select name="gypsumCharacterId" defaultValue={i?.gypsumCharacterId ?? ""} className="input"><option value="">—</option>{gypsum.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      {!i && <Field label="Harga awal / unit (IDR)"><input name="avgCost" inputMode="numeric" className="input" defaultValue="0" /></Field>}
      {i && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={i.active} /> Aktif</label>}
      <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  const supForm = (s?: (typeof suppliers)[number]) => (
    <ModalForm action={saveSupplier} className="space-y-3">
      {s && <input type="hidden" name="id" value={s.id} />}
      <Field label="Nama"><input name="name" defaultValue={s?.name} className="input" required /></Field>
      <Field label="Telepon"><input name="phone" defaultValue={s?.phone ?? ""} className="input" /></Field>
      <Field label="Alamat"><input name="address" defaultValue={s?.address ?? ""} className="input" /></Field>
      <Submit>Simpan</Submit>
    </ModalForm>
  );
  const locForm = (l?: (typeof locations)[number]) => (
    <ModalForm action={saveLocation} className="space-y-3">
      {l && <input type="hidden" name="id" value={l.id} />}
      <Field label="Kode"><input name="code" defaultValue={l?.code} className="input" required /></Field>
      <Field label="Nama"><input name="name" defaultValue={l?.name} className="input" required /></Field>
      <Field label="Divisi"><select name="divisionId" defaultValue={l?.divisionId ?? ""} className="input"><option value="">—</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Submit>Simpan</Submit>
    </ModalForm>
  );
  const gypForm = (g?: (typeof gypsum)[number]) => (
    <ModalForm action={saveGypsum} className="grid grid-cols-2 gap-3">
      {g && <input type="hidden" name="id" value={g.id} />}
      <Field label="Nama" className="col-span-2"><input name="name" defaultValue={g?.name} className="input" required /></Field>
      <Field label="Rasio air"><input name="waterRatio" defaultValue={g?.waterRatio ?? ""} className="input" placeholder="1 : 0,6" /></Field>
      <Field label="Waktu set (menit)"><input name="settingMinutes" defaultValue={g?.settingMinutes ?? ""} inputMode="numeric" className="input" /></Field>
      <Field label="Kekerasan"><input name="hardness" defaultValue={g?.hardness ?? ""} className="input" /></Field>
      <Field label="Catatan"><input name="note" defaultValue={g?.note ?? ""} className="input" /></Field>
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  const add = { item: <Modal trigger="+ Item" title="Item baru">{itemForm()}</Modal>, supplier: <Modal trigger="+ Supplier" title="Supplier baru">{supForm()}</Modal>, lokasi: <Modal trigger="+ Lokasi" title="Lokasi baru">{locForm()}</Modal>, gypsum: <Modal trigger="+ Karakter" title="Karakter gypsum baru">{gypForm()}</Modal> }[tab];
  return (
    <div>
      <PageHeader title="Master data stok" subtitle="Item & SKU, supplier, lokasi, karakter gypsum" actions={add} />
      <Tabs current={tab} tabs={[{ key: "item", label: "Item & SKU", href: "?tab=item", count: items.length }, { key: "supplier", label: "Supplier", href: "?tab=supplier", count: suppliers.length }, { key: "lokasi", label: "Lokasi", href: "?tab=lokasi", count: locations.length }, { key: "gypsum", label: "Karakter gypsum", href: "?tab=gypsum", count: gypsum.length }]} />
      <div className="table-wrap">
        <Paged><table className="tbl">
          {tab === "item" && (<>
            <thead><tr><th>SKU</th><th>Nama</th><th>Jenis</th><th>Satuan</th><th className="num">Min</th><th className="num">Harga beli terbaru</th><th className="num">Harga rata²</th><th>Supplier</th><th>Gypsum</th><th /></tr></thead>
            <tbody>{items.map((i) => <tr key={i.id} className={i.active ? "" : "opacity-50"}><td className="font-mono text-xs">{i.sku}</td><td>{i.name}</td><td><Badge>{ITEM_TYPE_LABEL[i.type]}</Badge></td><td>{i.unit}{recipeUnit(i) !== i.unit && <div className="text-xs text-slate-400">= {Number(i.hppFactor).toLocaleString("id-ID")} {recipeUnit(i)}</div>}</td><td className="num">{Number(i.minStock)}</td><td className="num">{idr(latestCost(i))}<div className="flex justify-end gap-2"><TrendBadge t={trendOf(latestCost(i), previousCost(i))} />{recipeUnit(i) !== i.unit && <span className="text-xs text-slate-400">{fmtUnitPrice(costPerRecipeUnit(latestCost(i), i))}/{recipeUnit(i)}</span>}</div></td><td className="num">{idr(i.avgCost)}</td><td>{i.supplier?.name}</td><td>{i.gypsumCharacter?.name}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah item">{itemForm(i)}</Modal></td></tr>)}</tbody>
          </>)}
          {tab === "supplier" && (<>
            <thead><tr><th>Nama</th><th>Telepon</th><th>Alamat</th><th className="num">Item</th><th /></tr></thead>
            <tbody>{suppliers.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.phone}</td><td>{s.address}</td><td className="num">{s._count.items}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah supplier">{supForm(s)}</Modal></td></tr>)}</tbody>
          </>)}
          {tab === "lokasi" && (<>
            <thead><tr><th>Kode</th><th>Nama</th><th>Divisi</th><th /></tr></thead>
            <tbody>{locations.map((l) => <tr key={l.id}><td className="font-mono text-xs">{l.code}</td><td>{l.name}</td><td>{l.division?.name}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah lokasi">{locForm(l)}</Modal></td></tr>)}</tbody>
          </>)}
          {tab === "gypsum" && (<>
            <thead><tr><th>Nama</th><th>Rasio air</th><th>Waktu set</th><th>Kekerasan</th><th>Catatan</th><th /></tr></thead>
            <tbody>{gypsum.map((g) => <tr key={g.id}><td>{g.name}</td><td>{g.waterRatio}</td><td>{g.settingMinutes ? `${g.settingMinutes} menit` : "-"}</td><td>{g.hardness}</td><td>{g.note}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah karakter">{gypForm(g)}</Modal></td></tr>)}</tbody>
          </>)}
        </table></Paged>
      </div>
    </div>
  );
}
