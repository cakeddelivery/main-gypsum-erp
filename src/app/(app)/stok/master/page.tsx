import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ITEM_TYPE_LABEL } from "@/lib/stock";
import { idr } from "@/lib/money";
import { Badge, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { TrendBadge } from "@/components/Trend";
import { costPerRecipeUnit, fmtUnitPrice, latestCost, previousCost, recipeUnit, trendOf } from "@/lib/unitcost";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import Link from "next/link";
import { saveGypsum, saveItem, saveLocation } from "../actions";
import { ItemFields } from "./ItemFields";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Master Stok" };

export default async function MasterPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requirePerm("master.manage");
  const { tab = "item" } = await searchParams;
  const [items, suppliers, locations, gypsum, divisions] = await Promise.all([
    prisma.item.findMany({ include: { supplier: true, gypsumCharacter: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ include: { division: true }, orderBy: { code: "asc" } }),
    prisma.gypsumCharacter.findMany({ orderBy: { name: "asc" } }),
    prisma.division.findMany({ orderBy: { code: "asc" } }),
  ]);
  const opt = (x: { id: string; name: string }) => ({ id: x.id, name: x.name });
  const itemForm = (i?: (typeof items)[number]) => (
    <ModalForm action={saveItem}>
      <ItemFields
        i={i && { id: i.id, sku: i.sku, name: i.name, type: i.type, category: i.category, unit: i.unit, hppUnit: i.hppUnit, hppFactor: Number(i.hppFactor), minStock: Number(i.minStock), supplierId: i.supplierId, divisionId: i.divisionId, gypsumCharacterId: i.gypsumCharacterId, note: i.note, active: i.active, lastCost: latestCost(i) }}
        suppliers={suppliers.map(opt)}
        divisions={divisions.map(opt)}
        gypsum={gypsum.map(opt)}
      />
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
  // Bahan baku dikelompokkan per divisi; barang dalam proses & barang jadi masing-masing satu grup
  const raw = items.filter((i) => i.type === "BAHAN_BAKU");
  const groups = [
    ...divisions.map((d) => ({ key: d.id, label: `Bahan baku · ${d.name}`, hint: d.code, items: raw.filter((i) => i.divisionId === d.id) })),
    { key: "raw-none", label: "Bahan baku · tanpa divisi", hint: "atur divisinya lewat Ubah", items: raw.filter((i) => !i.divisionId) },
    { key: "wip", label: ITEM_TYPE_LABEL.BARANG_DALAM_PROSES, hint: "hasil cetak / borongan sebelum jadi produk", items: items.filter((i) => i.type === "BARANG_DALAM_PROSES") },
    { key: "fg", label: ITEM_TYPE_LABEL.BARANG_JADI, hint: "produk jadi, terhubung ke menu Produk", items: items.filter((i) => i.type === "BARANG_JADI") },
  ].filter((g) => g.items.length > 0);
  const add = { item: <Modal trigger="+ Item" title="Tambah item" wide>{itemForm()}</Modal>, lokasi: <Modal trigger="+ Lokasi" title="Lokasi baru">{locForm()}</Modal>, gypsum: <Modal trigger="+ Karakter" title="Karakter gypsum baru">{gypForm()}</Modal> }[tab];
  return (
    <div>
      <PageHeader title="Master data stok" subtitle={<>Item & kode (bahan baku, barang setengah jadi, produk jadi), lokasi, karakter gypsum. Data supplier ada di menu <Link href="/supplier" className="underline">Supplier</Link>.</>} actions={add} />
      <Tabs current={tab} tabs={[{ key: "item", label: "Item & SKU", href: "?tab=item", count: items.length }, { key: "lokasi", label: "Lokasi", href: "?tab=lokasi", count: locations.length }, { key: "gypsum", label: "Karakter gypsum", href: "?tab=gypsum", count: gypsum.length }]} />
      {tab === "item" && (items.length === 0 ? <Empty title="Belum ada item" /> : (
        <div className="space-y-3">
          {groups.map((g, gi) => (
            <details key={g.key} open={gi === 0} className="group rounded-xl border border-slate-200 bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                  <span className="font-semibold text-slate-900">{g.label}</span>
                  <span className="ml-2 text-xs text-slate-500">{g.hint}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge>{g.items.length} item</Badge>
                  <span aria-hidden className="text-slate-500 transition-transform group-open:rotate-180">▾</span>
                </span>
              </summary>
              <div className="table-wrap border-t border-slate-200">
                <Paged><table className="tbl">
                  <thead><tr><th>Nama</th><th>Kategori</th><th>Satuan</th><th className="num">Reorder</th><th className="num">Harga beli terbaru</th><th className="num">Harga rata²</th><th>Supplier</th><th>Gypsum</th><th /></tr></thead>
                  <tbody>{g.items.map((i) => <tr key={i.id} className={i.active ? "" : "opacity-50"}><td>{i.name}{i.note && <div className="text-xs text-slate-400">{i.note}</div>}</td><td>{i.category ?? "-"}</td><td>{i.unit}{recipeUnit(i) !== i.unit && <div className="text-xs text-slate-400">= {Number(i.hppFactor).toLocaleString("id-ID")} {recipeUnit(i)}</div>}</td><td className="num">{Number(i.minStock)}</td><td className="num">{idr(latestCost(i))}<div className="flex justify-end gap-2"><TrendBadge t={trendOf(latestCost(i), previousCost(i))} />{recipeUnit(i) !== i.unit && <span className="text-xs text-slate-400">{fmtUnitPrice(costPerRecipeUnit(latestCost(i), i))}/{recipeUnit(i)}</span>}</div></td><td className="num">{idr(i.avgCost)}</td><td>{i.supplier?.name}</td><td>{i.gypsumCharacter?.name}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah item" wide>{itemForm(i)}</Modal></td></tr>)}</tbody>
                </table></Paged>
              </div>
            </details>
          ))}
        </div>
      ))}
      {tab !== "item" && <div className="table-wrap">
        <Paged><table className="tbl">
          {tab === "lokasi" && (<>
            <thead><tr><th>Nama</th><th>Divisi</th><th /></tr></thead>
            <tbody>{locations.map((l) => <tr key={l.id}><td className="font-mono text-xs">{l.code}</td><td>{l.name}</td><td>{l.division?.name}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah lokasi">{locForm(l)}</Modal></td></tr>)}</tbody>
          </>)}
          {tab === "gypsum" && (<>
            <thead><tr><th>Nama</th><th>Rasio air</th><th>Waktu set</th><th>Kekerasan</th><th>Catatan</th><th /></tr></thead>
            <tbody>{gypsum.map((g) => <tr key={g.id}><td>{g.name}</td><td>{g.waterRatio}</td><td>{g.settingMinutes ? `${g.settingMinutes} menit` : "-"}</td><td>{g.hardness}</td><td>{g.note}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah karakter">{gypForm(g)}</Modal></td></tr>)}</tbody>
          </>)}
        </table></Paged>
      </div>}
    </div>
  );
}
