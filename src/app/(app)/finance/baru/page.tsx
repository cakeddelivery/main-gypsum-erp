import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/time";
import { Card, PageHeader } from "@/components/ui";
import { TxForm } from "../TxForm";
import { createTx, extractAction } from "../actions";

export const metadata = { title: "Transaksi Baru" };

export default async function BaruPage() {
  await requirePerm("finance.create");
  const [banks, categories, stores, def] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.setting.findUnique({ where: { key: "default_store_id" } }),
  ]);
  return (
    <div>
      <PageHeader title="Transaksi baru" subtitle="Masuk ke Finance Inbox sebagai draft — baru dibukukan setelah disetujui pihak berwenang" />
      <Card>
        <TxForm mode="create" action={createTx} extract={extractAction} banks={banks} categories={categories} stores={stores} init={{ direction: "KELUAR", date: todayStr(), storeId: def?.value ?? stores[0]?.id }} />
      </Card>
    </div>
  );
}
