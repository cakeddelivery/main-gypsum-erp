import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { reportDivision } from "@/lib/reportScope";
import { fmtDay } from "@/lib/time";
import { materialOrderList, orderVerb } from "@/lib/shiftReportStock";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Order & Produksi" };

/** Rekap order & produksi: hitungan stok terakhir dari laporan shift; bahan baku ≤ limit "perlu diorder", setengah jadi / barang jadi ≤ limit "perlu diproduksi" */
export default async function OrderBahanPage() {
  const user = await requirePerm("report.view");
  const fixedDivision = reportDivision(user);
  const groups = (await materialOrderList(fixedDivision)).map((g) => ({ d: g.division, order: g.order, uncounted: g.uncounted }));
  const total = groups.reduce((a, g) => a + g.order.filter((o) => o.kind !== "PRODUKSI").length, 0);
  const totalProd = groups.reduce((a, g) => a + g.order.filter((o) => o.kind === "PRODUKSI").length, 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Order & produksi" subtitle={`${total} bahan baku perlu diorder · ${totalProd} setengah jadi / barang jadi perlu diproduksi (stok akhir terakhir ≤ limit)`} />
      {groups.length === 0 && <Empty title="Belum ada bahan baku divisi" />}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(({ d, order, uncounted }) => (
          <Card key={d.id} title={d.name} actions={<Badge tone={order.length ? "red" : "green"}>{order.length ? `${order.filter((o) => o.kind !== "PRODUKSI").length ? `${order.filter((o) => o.kind !== "PRODUKSI").length} perlu order` : ""}${order.some((o) => o.kind !== "PRODUKSI") && order.some((o) => o.kind === "PRODUKSI") ? " · " : ""}${order.filter((o) => o.kind === "PRODUKSI").length ? `${order.filter((o) => o.kind === "PRODUKSI").length} perlu produksi` : ""}` : "Aman"}</Badge>}>
            {order.length === 0 ? <p className="text-sm text-slate-500">Semua barang di atas limit.</p> : (
              <ul className="divide-y divide-slate-100">
                {order.map((o) => (
                  <li key={o.itemId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
                    <span className={`font-medium ${o.kind === "PRODUKSI" ? "text-amber-700" : "text-rose-700"}`}>{o.kind === "PRODUKSI" ? "🏭" : "⚠"} {o.name}<span className="ml-1.5 text-xs font-normal">({orderVerb(o.kind)})</span>{o.requested && <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">sudah diminta</span>}</span>
                    <span className="text-slate-600">stok {o.qty.toLocaleString("id-ID")} · limit {o.limit.toLocaleString("id-ID")} {o.unit}</span>
                    {o.url && <a href={o.url} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm">🛒 Order online</a>}
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
