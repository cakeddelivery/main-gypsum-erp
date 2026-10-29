import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { TERM_LABEL } from "@/lib/purchase";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { PurchaseFields } from "./PurchaseForm";
import { savePurchase } from "./actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Pembelian Bahan Baku" };

export default async function PembelianPage() {
  const user = await requirePerm("stock.view", "accounting.view");
  const [items, suppliers, banks, stores, purchases] = await Promise.all([
    prisma.item.findMany({ where: { active: true, type: "BAHAN_BAKU" }, orderBy: { sku: "asc" } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.store.findMany({ orderBy: { code: "asc" } }),
    prisma.purchase.findMany({ include: { lines: { include: { item: true } } }, orderBy: { date: "desc" }, take: 50 }),
  ]);
  const defaultStore = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
  const payables = await prisma.payable.findMany({ where: { id: { in: purchases.map((p) => p.payableId).filter((x): x is string => !!x) } } });
  return (
    <div className="space-y-5">
      <PageHeader title="Pembelian bahan baku" subtitle="Bayar di depan, bertahap (DP), atau tempo. Stok, jurnal, dan utang tercatat sekaligus." actions={user.can("finance.approve") && (
        <Modal trigger="+ Pembelian" title="Pembelian baru" wide>
          <ModalForm action={savePurchase}>
            <PurchaseFields items={items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, unit: i.unit, avgCost: Number(i.avgCost) }))} suppliers={suppliers} banks={banks} stores={stores} today={todayStr()} defaultBank={banks.find((b) => b.code === "SEABANK")?.id} defaultStore={defaultStore} />
            <div className="mt-4"><Submit>Simpan pembelian</Submit></div>
          </ModalForm>
        </Modal>
      )} />
      {purchases.length === 0 ? <Empty title="Belum ada pembelian" /> : (
        <Card title="Riwayat pembelian">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Supplier</th><th>Item</th><th>Cara bayar</th><th className="num">Total</th><th className="num">Dibayar di muka</th><th>Sisa utang</th></tr></thead>
              <tbody>
                {purchases.map((p) => {
                  const pay = payables.find((x) => x.id === p.payableId);
                  const rem = pay ? Number(pay.amount - pay.paid) : 0;
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.number}</td><td>{fmtDate(p.date)}</td><td>{p.vendor}</td>
                      <td className="text-xs">{p.lines.map((l) => `${l.item.name} × ${Number(l.qty).toLocaleString("id-ID")}`).join(", ")}</td>
                      <td>{TERM_LABEL[p.term]}</td><td className="num">{idr(p.total)}</td><td className="num">{idr(p.paidNow)}</td>
                      <td>{pay ? (rem > 0 ? <Link href="/akuntansi/piutang-utang?tab=utang"><Badge tone={pay.dueDate && pay.dueDate < new Date() ? "red" : "amber"}>{idr(rem)} · {fmtDate(pay.dueDate)}</Badge></Link> : <Badge tone="green">Lunas</Badge>) : <Badge tone="green">Lunas</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></Paged>
          </div>
        </Card>
      )}
    </div>
  );
}
