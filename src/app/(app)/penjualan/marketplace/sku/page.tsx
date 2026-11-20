import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { skuOverview } from "@/lib/marketplace/report";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { MpNav } from "../MpNav";
import { SkuRow } from "./SkuRow";

export const metadata = { title: "Pemetaan SKU Marketplace" };

/** Kiri: SKU + nama produk dalam 1 baris (dipotong, tooltip penuh) + jumlah pesanan */
function Info({ r, label, badge }: { r: { orders: number; sample?: { name: string | null } }; label: string; badge?: React.ReactNode }) {
  const title = `${label} · ${r.sample?.name ?? ""} · ${r.orders} pesanan`;
  return (
    <div className="min-w-0 flex-1" title={title}>
      <p className="truncate text-sm font-medium">{label} {badge}</p>
      <p className="truncate text-xs text-slate-500">{r.sample?.name ?? "-"} · {r.orders} pesanan</p>
    </div>
  );
}

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
          <ul className="divide-y divide-slate-100">
            {todo.map((r) => (
              <li key={r.key} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <Info r={r} label={label(r)} />
                {canManage && <SkuRow skuKey={r.key} items={items} kind="PRODUK" />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Sudah dikenali (${done.length})`}>
        <ul className="divide-y divide-slate-100">
          {done.map((r) => (
            <li key={r.key} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <Info r={r} label={label(r)} badge={r.resolved!.kind === "PRODUK" ? <Badge tone={r.resolved!.by === "PETA" ? "green" : "blue"}>{r.resolved!.by === "PETA" ? "Dipetakan" : "Otomatis"}</Badge> : <Badge tone="purple">Extra Packing</Badge>} />
              {canManage && <SkuRow skuKey={r.key} items={items} kind={r.resolved!.kind} itemId={r.resolved!.kind === "PRODUK" ? r.resolved!.itemId : undefined} variant={r.resolved!.kind === "EXTRA_PACKING" ? r.resolved!.variant : undefined} />}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
