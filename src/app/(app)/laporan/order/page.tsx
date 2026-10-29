import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDay } from "@/lib/time";
import { needsOrder, type StockCountRow } from "@/lib/shiftReport";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Order Bahan Baku" };

/** Rekap order bahan baku: hitungan stok terakhir tiap bahan dari laporan shift, yang ≤ limit perlu diorder */
export default async function OrderBahanPage() {
  const user = await requirePerm("report.view");
  const fixedDivision = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" ? (user.divisionId ?? "-") : null;
  const divisions = await prisma.division.findMany({
    where: { active: true, items: { some: { active: true } }, ...(fixedDivision ? { id: fixedDivision } : {}) },
    orderBy: { code: "asc" },
    include: { items: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  // Laporan terbaru dulu: hitungan pertama yang ditemukan per bahan = hitungan terakhir
  const reports = await prisma.shiftReport.findMany({
    where: { divisionId: { in: divisions.map((d) => d.id) } },
    orderBy: [{ date: "desc" }, { shift: { code: "desc" } }, { createdAt: "desc" }],
    take: 200,
    select: { id: true, date: true, stockCount: true, shift: { select: { name: true } } },
  });
  const last = new Map<string, { qty: number; reportId: string; date: Date; shift: string }>();
  for (const r of reports) for (const s of r.stockCount as StockCountRow[]) if (s.qty != null && !last.has(s.itemId)) last.set(s.itemId, { qty: s.qty, reportId: r.id, date: r.date, shift: r.shift.name });

  const groups = divisions.map((d) => {
    const rows = d.items.map((i) => ({ item: i, limit: Number(i.minStock), count: last.get(i.id) }));
    return { d, rows, order: rows.filter((r) => r.count && needsOrder({ qty: r.count.qty, limit: r.limit })), uncounted: rows.filter((r) => !r.count) };
  });
  const total = groups.reduce((a, g) => a + g.order.length, 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Order bahan baku" subtitle={`${total} bahan perlu diorder (stok akhir shift terakhir ≤ limit)`} actions={<Link href="/laporan" className="btn-secondary">← Laporan shift</Link>} />
      {groups.length === 0 && <Empty title="Belum ada bahan baku divisi" />}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(({ d, order, uncounted }) => (
          <Card key={d.id} title={d.name} actions={<Badge tone={order.length ? "red" : "green"}>{order.length ? `${order.length} perlu order` : "Aman"}</Badge>}>
            {order.length === 0 ? <p className="text-sm text-slate-500">Semua bahan di atas limit.</p> : (
              <ul className="divide-y divide-slate-100">
                {order.map(({ item, limit, count }) => (
                  <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
                    <span className="font-medium text-rose-700">⚠ {item.name}</span>
                    <span className="text-slate-600">stok {count!.qty.toLocaleString("id-ID")} · limit {limit.toLocaleString("id-ID")} {item.unit}</span>
                    <Link href={`/laporan/${count!.reportId}`} className="w-full text-xs text-slate-400 hover:underline">dihitung {fmtDay(count!.date)} · {count!.shift}</Link>
                  </li>
                ))}
              </ul>
            )}
            {uncounted.length > 0 && <p className="mt-2 text-xs text-slate-400">Belum pernah dihitung: {uncounted.map((u) => u.item.name).join(", ")}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
