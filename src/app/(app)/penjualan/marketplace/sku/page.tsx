import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { skuOverview } from "@/lib/marketplace/report";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { MpNav } from "../MpNav";
import { SkuRow } from "./SkuRow";

export const metadata = { title: "Pemetaan SKU Marketplace" };

export default async function SkuPage() {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const [rows, items] = await Promise.all([skuOverview(), prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  const todo = rows.filter((r) => !r.resolved);
  const done = rows.filter((r) => r.resolved);
  const label = (r: (typeof rows)[number]) => [r.sample?.sku, r.sample?.variation].filter(Boolean).join(" · ") || r.key;
  return (
    <div className="space-y-4">
      <PageHeader title="Pemetaan SKU" subtitle="Pilih sekali, diingat seterusnya · dipakai bersama menu Retur" />
      <MpNav current="sku" />
      <p className="text-sm text-slate-500">“12 MIX”, “12MIX”, dan “MG-12MIX” dibaca sebagai SKU yang sama. Extra Packing (Bubble Wrap, Extra Dus) adalah pendapatan tambahan, bukan produk jadi: tidak masuk penjualan produk dan tidak menyentuh stok.</p>
      <Card title={`Belum dipetakan (${todo.length})`}>
        {todo.length === 0 ? <Empty title="Semua SKU sudah dikenali" /> : (
          <div className="space-y-3">
            {todo.map((r) => (
              <div key={r.key} className="rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-medium">{label(r)} <span className="font-normal text-slate-400">· {r.sample?.name} · {r.orders} pesanan</span></p>
                {canManage && <div className="mt-2"><SkuRow skuKey={r.key} items={items} kind="PRODUK" /></div>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={`Sudah dikenali (${done.length})`}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>SKU</th><th className="num">Pesanan</th><th>Produk / jenis</th><th></th></tr></thead>
            <tbody>
              {done.map((r) => (
                <tr key={r.key}>
                  <td>{label(r)}</td>
                  <td className="num">{r.orders}</td>
                  <td>{r.resolved!.kind === "PRODUK" ? <>{r.resolved!.itemName} <Badge tone={r.resolved!.by === "PETA" ? "green" : "blue"}>{r.resolved!.by === "PETA" ? "Dipetakan" : "Otomatis"}</Badge></> : <><Badge tone="purple">Extra Packing</Badge> {r.resolved!.variant}</>}</td>
                  <td>{canManage && <SkuRow skuKey={r.key} items={items} kind={r.resolved!.kind} itemId={r.resolved!.kind === "PRODUK" ? r.resolved!.itemId : undefined} variant={r.resolved!.kind === "EXTRA_PACKING" ? r.resolved!.variant : undefined} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
