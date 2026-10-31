import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ITEM_TYPE_LABEL, needsReorder, stockBalances } from "@/lib/stock";
import { idr } from "@/lib/money";
import { Badge, Empty, FilterBar, Field, PageHeader, Stat, Tabs } from "@/components/ui";
import type { ItemType } from "@prisma/client";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";

export const metadata = { title: "Stok & Persediaan" };

export default async function StokPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; filter?: string; loc?: string }> }) {
  const user = await requirePerm("stock.view", "stock.request");
  const sp = await searchParams;
  const [items, locations, balances] = await Promise.all([
    prisma.item.findMany({ where: { active: true, ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { sku: { contains: sp.q, mode: "insensitive" } }] } : {}) }, include: { supplier: true }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.location.findMany({ orderBy: { code: "asc" }, include: { division: true } }),
    stockBalances(),
  ]);
  const shownLocs = sp.loc ? locations.filter((l) => l.id === sp.loc) : locations;
  const qty = (itemId: string, locId?: string) => balances.filter((b) => b.itemId === itemId && (!locId || b.locationId === locId)).reduce((s, b) => s + b.qty, 0);
  // Tab: semua / per jenis / perlu reorder (stok ≤ batas minimum, dihitung dari total semua lokasi)
  const tab = sp.filter === "menipis" ? "reorder" : sp.type ?? "semua";
  const all = items.map((i) => ({ ...i, total: sp.loc ? qty(i.id, sp.loc) : qty(i.id), min: Number(i.minStock), reorder: needsReorder(qty(i.id), Number(i.minStock)) }));
  const rows = tab === "reorder" ? all.filter((r) => r.reorder) : tab === "semua" ? all : all.filter((r) => r.type === tab);
  const value = (t: ItemType) => items.filter((i) => i.type === t).reduce((s, i) => s + qty(i.id) * Number(i.avgCost), 0);
  const low = all.filter((r) => r.reorder).length;
  const keep = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, loc: sp.loc, ...extra })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : "?";
  };
  const count = (t: ItemType) => all.filter((r) => r.type === t).length;

  return (
    <div>
      <PageHeader
        title="Stok & persediaan"
        subtitle="Bahan baku, barang setengah jadi, dan produk jadi per lokasi"
        actions={
          <>
            {(user.can("finance.approve") || user.can("accounting.view")) && <Link href="/stok/pembelian" className="btn-primary">Pembelian</Link>}
            {user.can("stock.move") && <Link href="/stok/mutasi" className="btn-secondary">Mutasi stok</Link>}
            {(user.can("stock.request") || user.can("stock.approve")) && <Link href="/stok/permintaan" className="btn-secondary">Permintaan</Link>}
            {user.can("stock.view") && <Link href="/stok/kartu" className="btn-secondary">Kartu persediaan</Link>}
            {user.can("master.manage") && <Link href="/stok/master" className="btn-secondary">Master data</Link>}
            {user.can("stock.view") && <DownloadCsv filename={`stok-${tab}`} rows={[["Kode", "Nama", "Jenis", "Satuan", "Stok", "Batas minimum", "Perlu order", "Harga rata-rata (Rp)", "Nilai (Rp)", "Supplier"], ...rows.map((r) => [r.sku, r.name, ITEM_TYPE_LABEL[r.type], r.unit, r.total, r.min, r.reorder ? "Ya" : "", Number(r.avgCost), Math.round(r.total * Number(r.avgCost)), r.supplier?.name ?? ""])]} />}
          </>
        }
      />
      {user.can("stock.view") && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Nilai bahan baku" value={idr(value("BAHAN_BAKU"))} />
          <Stat label="Nilai barang setengah jadi" value={idr(value("BARANG_DALAM_PROSES"))} />
          <Stat label="Nilai produk jadi" value={idr(value("BARANG_JADI"))} tone="blue" />
          <Stat label="Perlu reorder" value={low} tone={low ? "red" : "green"} href="/stok?filter=menipis" hint="stok ≤ batas minimum" />
        </div>
      )}
      <Tabs
        current={tab}
        tabs={[
          { key: "semua", label: "Semua", href: keep({}), count: all.length },
          { key: "BAHAN_BAKU", label: "Bahan baku", href: keep({ type: "BAHAN_BAKU" }), count: count("BAHAN_BAKU") },
          { key: "BARANG_DALAM_PROSES", label: "Setengah jadi", href: keep({ type: "BARANG_DALAM_PROSES" }), count: count("BARANG_DALAM_PROSES") },
          { key: "BARANG_JADI", label: "Produk jadi", href: keep({ type: "BARANG_JADI" }), count: count("BARANG_JADI") },
          { key: "reorder", label: "Perlu reorder", href: keep({ filter: "menipis" }), count: low },
        ]}
      />
      <FilterBar>
        {sp.type && <input type="hidden" name="type" value={sp.type} />}
        {sp.filter && <input type="hidden" name="filter" value={sp.filter} />}
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="Nama item" /></Field>
        <Field label="Lokasi"><select name="loc" defaultValue={sp.loc ?? ""} className="input"><option value="">Semua lokasi</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title={tab === "reorder" ? "Tidak ada item yang perlu reorder" : "Tidak ada item"} /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Nama</th><th>Jenis</th>{shownLocs.map((l) => <th key={l.id} className="num">{l.code}</th>)}<th className="num">Total</th><th className="num">Batas min</th>{user.can("stock.view") && <th className="num">Harga rata²</th>}<th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}{r.supplier && <div className="text-xs text-slate-400">{r.supplier.name}</div>}</td>
                  <td><Badge tone={r.type === "BARANG_JADI" ? "blue" : r.type === "BAHAN_BAKU" ? "gray" : "purple"}>{ITEM_TYPE_LABEL[r.type]}</Badge></td>
                  {shownLocs.map((l) => <td key={l.id} className="num">{fmtQty(qty(r.id, l.id))}</td>)}
                  <td className="num font-semibold">{fmtQty(r.total)} <span className="text-xs font-normal text-slate-400">{r.unit}</span></td>
                  <td className="num">{r.reorder ? <Badge tone="red">{fmtQty(r.min)} · reorder</Badge> : fmtQty(r.min)}</td>
                  {user.can("stock.view") && <td className="num">{idr(r.avgCost)}</td>}
                  <td>{user.can("stock.view") && <Link className="link text-xs" href={`/stok/kartu?item=${r.id}`}>Kartu</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}

function fmtQty(n: number) {
  return Number(n.toFixed(3)).toLocaleString("id-ID");
}
