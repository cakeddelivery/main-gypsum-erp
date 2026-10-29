import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { productCosting, latestPrices, margin } from "@/lib/hpp";
import { idr } from "@/lib/money";
import { Badge, Empty, FilterBar, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ProductForm } from "./ProductForm";
import type { ProductType, ProductVariant } from "@prisma/client";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Produk & HPP" };
const TYPE_LABEL: Record<ProductType, string> = { SATUAN: "Satuan", PAKET_12: "Paket 12", PAKET_24: "Paket 24", PAKET_48: "Paket 48", GIFTBOX: "Giftbox", CUSTOM: "Custom" };

export default async function ProdukPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; variant?: string; store?: string }> }) {
  const user = await requirePerm("product.view");
  const sp = await searchParams;
  const [products, stores, items] = await Promise.all([
    prisma.product.findMany({ where: { ...(sp.type ? { type: sp.type as ProductType } : {}), ...(sp.variant ? { variant: sp.variant as ProductVariant } : {}), ...(sp.store ? { storeId: sp.store } : {}), ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { sku: { contains: sp.q, mode: "insensitive" } }] } : {}) }, include: { store: true }, orderBy: [{ active: "desc" }, { sku: "asc" }] }),
    prisma.store.findMany(),
    prisma.item.findMany({ where: { type: "BARANG_JADI" }, orderBy: { sku: "asc" } }),
  ]);
  const rows = await Promise.all(products.map(async (p) => ({ p, cost: await productCosting(p.id), prices: (await latestPrices(p.id)).latest })));
  const canHpp = user.can("product.manage") || user.can("accounting.view") || user.role === "OWNER";
  return (
    <div>
      <PageHeader title="Produk & HPP" subtitle="Satuan, paket 12/24/48, giftbox, custom · BOM, biaya, harga & margin" actions={user.can("product.manage") && <Modal trigger="+ Produk" title="Produk baru"><ProductForm stores={stores} items={items} /></Modal>} />
      <FilterBar>
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" /></Field>
        <Field label="Tipe"><select name="type" defaultValue={sp.type ?? ""} className="input"><option value="">Semua</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Varian"><select name="variant" defaultValue={sp.variant ?? ""} className="input"><option value="">Semua</option>{["COWOK", "CEWEK", "HEWAN", "TRANSPORTASI", "MIX"].map((v) => <option key={v} value={v}>{v}</option>)}</select></Field>
        <Field label="Toko"><select name="store" defaultValue={sp.store ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>SKU</th><th>Nama</th><th>Tipe</th><th>Varian</th><th>Toko</th>{canHpp && <th className="num">HPP</th>}<th className="num">Harga (offline)</th>{canHpp && <th className="num">Margin</th>}<th /></tr></thead>
            <tbody>
              {rows.map(({ p, cost, prices }) => {
                const off = prices.get("OFFLINE") ?? [...prices.values()][0];
                const mg = off ? margin(Number(off.price), cost.hpp) : null;
                return (
                  <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                    <td className="font-mono text-xs">{p.sku}</td><td>{p.name}</td><td><Badge tone="blue">{TYPE_LABEL[p.type]}</Badge></td><td>{p.variant}</td><td>{p.store.name}</td>
                    {canHpp && <td className="num">{idr(cost.hpp)}</td>}
                    <td className="num">{off ? idr(off.price) : "-"}</td>
                    {canHpp && <td className="num">{mg ? <span className={mg.value < 0 ? "text-rose-600" : "text-emerald-600"}>{mg.pct}%</span> : "-"}</td>}
                    <td><Link href={`/produk/${p.id}`} className="btn-secondary btn-sm">Detail</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
