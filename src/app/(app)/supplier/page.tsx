import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PartnerList } from "./PartnerList";
import { deleteSupplier, saveSupplier } from "./actions";

export const metadata = { title: "Supplier" };

export default async function SupplierPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePerm("partner.view");
  const { q } = await searchParams;
  const rows = await prisma.supplier.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { address: { contains: q, mode: "insensitive" } }] } : {},
    include: { _count: { select: { items: true, purchases: true } } },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return (
    <PartnerList
      kind="Supplier"
      subtitle="Pemasok bahan baku. Supplier dipakai di item stok dan pembelian bahan."
      q={q}
      canManage={user.can("partner.manage")}
      save={saveSupplier}
      remove={deleteSupplier}
      extraHeader="Dipakai"
      rows={rows.map((s) => ({ ...s, extra: <span className="text-xs">{s._count.items} item · {s._count.purchases} pembelian</span> }))}
    />
  );
}
