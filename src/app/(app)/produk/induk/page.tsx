import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Empty, PageHeader } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { ProdukTabs } from "../ProdukTabs";
import { familyInclude, familyMatrix } from "@/lib/productFamily";

export const metadata = { title: "Produk Induk & Varian" };

export default async function IndukPage() {
  await requirePerm("product.view");
  const families = await prisma.productFamily.findMany({ include: familyInclude, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const ids = families.flatMap((f) => f.products.map((p) => p.id));
  const [withRecipe, withPrice] = await Promise.all([
    prisma.bomLine.groupBy({ by: ["productId"], where: { productId: { in: ids } } }),
    prisma.priceHistory.groupBy({ by: ["productId"], where: { productId: { in: ids } } }),
  ]);
  const rec = new Set(withRecipe.map((r) => r.productId));
  const pri = new Set(withPrice.map((r) => r.productId));
  return (
    <div>
      <PageHeader title="Produk Induk & Varian" subtitle="Satu produk induk, banyak varian (SKU): harga, resep, dan jumlah patung per SKU" />
      <ProdukTabs current="induk" />
      {families.length === 0 ? <Empty title="Belum ada produk induk" hint="Jalankan skrip katalog produk (npm run katalog:produk) untuk mengisi Giftbox, Satuan Single Pack, dan Paket Single Pack." /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Kode</th><th>Produk induk</th><th>Kategori varian</th><th className="num">SKU</th><th className="num">Resep terisi</th><th className="num">Harga terisi</th><th /></tr></thead>
            <tbody>
              {families.map((f) => {
                const m = familyMatrix(f);
                const made = m.filter((x) => x.product);
                return (
                  <tr key={f.id} className={f.active ? "" : "opacity-50"}>
                    <td className="font-mono text-xs">{f.code}</td>
                    <td>{f.name}{f.note && <div className="text-xs text-slate-500">{f.note}</div>}</td>
                    <td className="text-sm">{f.axes.map((a) => `${a.name} (${a.options.filter((o) => o.active).length})`).join(" × ")}</td>
                    <td className="num">{made.length}{made.length < m.length && <div className="text-xs text-amber-600">{m.length - made.length} belum dibuat</div>}</td>
                    <td className="num">{made.filter((x) => rec.has(x.product!.id)).length}/{made.length}</td>
                    <td className="num">{made.filter((x) => pri.has(x.product!.id)).length}/{made.length}</td>
                    <td><Link href={`/produk/induk/${f.id}`} className="btn-secondary btn-sm">Buka</Link></td>
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
