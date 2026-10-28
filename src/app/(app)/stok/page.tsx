import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { stockBalances } from "@/lib/stock";
import { ITEM_TYPE_LABEL } from "@/lib/stock";
import { idr } from "@/lib/money";
import { Badge, Empty, FilterBar, Field, PageHeader, Stat } from "@/components/ui";
import type { ItemType } from "@prisma/client";

export const metadata = { title: "Stok & Persediaan" };

export default async function StokPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; filter?: string; loc?: string }> }) {
  const user = await requirePerm("stock.view", "stock.request");
  const sp = await searchParams;
  const [items, locations, balances] = await Promise.all([
    prisma.item.findMany({ where: { active: true, ...(sp.type ? { type: sp.type as ItemType } : {}), ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { sku: { contains: sp.q, mode: "insensitive" } }] } : {}) }, include: { supplier: true }, orderBy: [{ type: "asc" }, { sku: "asc" }] }),
    prisma.location.findMany({ orderBy: { code: "asc" }, include: { division: true } }),
    stockBalances(),
  ]);
  const shownLocs = sp.loc ? locations.filter((l) => l.id === sp.loc) : locations;
  const qty = (itemId: string, locId?: string) => balances.filter((b) => b.itemId === itemId && (!locId || b.locationId === locId)).reduce((s, b) => s + b.qty, 0);
  let rows = items.map((i) => ({ ...i, total: sp.loc ? qty(i.id, sp.loc) : qty(i.id), min: Number(i.minStock) }));
  if (sp.filter === "menipis") rows = rows.filter((r) => r.min > 0 && r.total < r.min);
  const value = (t: ItemType) => items.filter((i) => i.type === t).reduce((s, i) => s + qty(i.id) * Number(i.avgCost), 0);
  const low = items.filter((i) => Number(i.minStock) > 0 && qty(i.id) < Number(i.minStock)).length;

  return (
    <div>
      <PageHeader
        title="Stok & persediaan"
        subtitle="Bahan baku, barang dalam proses, dan barang jadi per lokasi"
        actions={
          <>
            {user.can("stock.move") && <Link href="/stok/mutasi" className="btn-primary">Mutasi stok</Link>}
            {(user.can("stock.request") || user.can("stock.approve")) && <Link href="/stok/permintaan" className="btn-secondary">Permintaan</Link>}
            {user.can("stock.view") && <Link href="/stok/kartu" className="btn-secondary">Kartu persediaan</Link>}
            {user.can("master.manage") && <Link href="/stok/master" className="btn-secondary">Master data</Link>}
          </>
        }
      />
      {user.can("stock.view") && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Nilai bahan baku" value={idr(value("BAHAN_BAKU"))} />
          <Stat label="Nilai barang dalam proses" value={idr(value("BARANG_DALAM_PROSES"))} />
          <Stat label="Nilai barang jadi" value={idr(value("BARANG_JADI"))} tone="blue" />
          <Stat label="Stok menipis" value={low} tone={low ? "red" : "green"} href="/stok?filter=menipis" />
        </div>
      )}
      <FilterBar>
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="SKU / nama" /></Field>
        <Field label="Jenis"><select name="type" defaultValue={sp.type ?? ""} className="input"><option value="">Semua</option>{Object.entries(ITEM_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Lokasi"><select name="loc" defaultValue={sp.loc ?? ""} className="input"><option value="">Semua lokasi</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Filter"><select name="filter" defaultValue={sp.filter ?? ""} className="input"><option value="">Semua</option><option value="menipis">Stok menipis</option></select></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title="Tidak ada item" /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>SKU</th><th>Nama</th><th>Jenis</th>{shownLocs.map((l) => <th key={l.id} className="num">{l.code}</th>)}<th className="num">Total</th><th className="num">Min</th>{user.can("stock.view") && <th className="num">Harga rata²</th>}<th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.sku}</td>
                  <td>{r.name}{r.supplier && <div className="text-xs text-slate-400">{r.supplier.name}</div>}</td>
                  <td><Badge tone={r.type === "BARANG_JADI" ? "blue" : r.type === "BAHAN_BAKU" ? "gray" : "purple"}>{ITEM_TYPE_LABEL[r.type]}</Badge></td>
                  {shownLocs.map((l) => <td key={l.id} className="num">{fmtQty(qty(r.id, l.id))}</td>)}
                  <td className="num font-semibold">{fmtQty(r.total)} <span className="text-xs font-normal text-slate-400">{r.unit}</span></td>
                  <td className="num">{r.min > 0 && r.total < r.min ? <Badge tone="red">{fmtQty(r.min)}</Badge> : fmtQty(r.min)}</td>
                  {user.can("stock.view") && <td className="num">{idr(r.avgCost)}</td>}
                  <td>{user.can("stock.view") && <Link className="link text-xs" href={`/stok/kartu?item=${r.id}`}>Kartu</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtQty(n: number) {
  return Number(n.toFixed(3)).toLocaleString("id-ID");
}
