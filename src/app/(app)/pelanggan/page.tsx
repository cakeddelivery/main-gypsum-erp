import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PartnerList } from "../supplier/PartnerList";
import { deleteCustomer, saveCustomer } from "../supplier/actions";

export const metadata = { title: "Pelanggan" };

export default async function PelangganPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePerm("partner.view");
  const { q } = await searchParams;
  const rows = await prisma.customer.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { address: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return (
    <PartnerList
      kind="Pelanggan"
      subtitle="Pembeli offline (langsung datang / pesan via WhatsApp), di luar marketplace."
      q={q}
      canManage={user.can("partner.manage")}
      save={saveCustomer}
      remove={deleteCustomer}
      rows={rows}
    />
  );
}
