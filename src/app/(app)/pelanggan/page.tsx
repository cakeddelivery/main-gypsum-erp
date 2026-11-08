import { requirePerm } from "@/lib/auth";
import { idr } from "@/lib/money";
import { prisma } from "@/lib/db";
import { PartnerList } from "../supplier/PartnerList";
import { deleteCustomer, saveCustomer } from "../supplier/actions";

export const metadata = { title: "Pelanggan" };

export default async function PelangganPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePerm("partner.view");
  const { q } = await searchParams;
  const rows = await prisma.customer.findMany({
    where: q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { address: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  // Total belanja & sisa piutang dari menu Penjualan (hanya untuk yang boleh melihat penjualan)
  const canSales = user.can("sales.view");
  const sums = canSales ? await prisma.sale.groupBy({ by: ["customerId"], where: { cancelledAt: null, customerId: { in: rows.map((r) => r.id) } }, _sum: { total: true, paid: true }, _count: true }) : [];
  return (
    <PartnerList
      kind="Pelanggan"
      subtitle="Pembeli offline (langsung datang / pesan via WhatsApp), di luar marketplace."
      q={q}
      canManage={user.can("partner.manage")}
      save={saveCustomer}
      remove={deleteCustomer}
      extraHeader={canSales ? "Belanja · sisa piutang" : undefined}
      rows={rows.map((r) => {
        const x = sums.find((g) => g.customerId === r.id);
        const rest = Number(x?._sum.total ?? 0) - Number(x?._sum.paid ?? 0);
        return {
          ...r,
          href: canSales ? `/penjualan?customer=${r.id}&from=2000-01-01` : undefined,
          extra: x ? <span className="text-xs">{idr(x._sum.total ?? 0)} ({x._count} nota){rest > 0 && <span className="block text-amber-700">sisa {idr(rest)}</span>}</span> : <span className="text-xs text-slate-400">—</span>,
        };
      })}
    />
  );
}
