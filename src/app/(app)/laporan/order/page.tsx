import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { fmtDay } from "@/lib/time";
import { materialOrderList } from "@/lib/shiftReportStock";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Order Bahan Baku" };

/** Rekap order bahan baku: hitungan stok terakhir tiap bahan dari laporan shift, yang ≤ limit perlu diorder */
export default async function OrderBahanPage() {
  const user = await requirePerm("report.view");
  const fixedDivision = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" ? (user.divisionId ?? "-") : null;
  const groups = (await materialOrderList(fixedDivision)).map((g) => ({ d: g.division, order: g.order, uncounted: g.uncounted }));
  const total = groups.reduce((a, g) => a + g.order.length, 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Order bahan baku" subtitle={`${total} bahan perlu diorder (stok akhir shift terakhir ≤ limit)`} />
      {groups.length === 0 && <Empty title="Belum ada bahan baku divisi" />}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(({ d, order, uncounted }) => (
          <Card key={d.id} title={d.name} actions={<Badge tone={order.length ? "red" : "green"}>{order.length ? `${order.length} perlu order` : "Aman"}</Badge>}>
            {order.length === 0 ? <p className="text-sm text-slate-500">Semua bahan di atas limit.</p> : (
              <ul className="divide-y divide-slate-100">
                {order.map((o) => (
                  <li key={o.itemId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
                    <span className="font-medium text-rose-700">⚠ {o.name}</span>
                    <span className="text-slate-600">stok {o.qty.toLocaleString("id-ID")} · limit {o.limit.toLocaleString("id-ID")} {o.unit}</span>
                    <Link href={`/laporan/${o.reportId}`} className="w-full text-xs text-slate-400 hover:underline">dihitung {fmtDay(o.date)} · {o.shift}</Link>
                  </li>
                ))}
              </ul>
            )}
            {uncounted.length > 0 && <p className="mt-2 text-xs text-slate-400">Belum pernah dihitung: {uncounted.map((u) => u.name).join(", ")}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
