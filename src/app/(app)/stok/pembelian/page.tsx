import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { latestCost } from "@/lib/unitcost";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { PurchaseFields } from "./PurchaseForm";
import { savePurchase } from "./actions";
import { Paged } from "@/components/Paged";
import { ProofPreview } from "@/components/ProofPreview";

export const metadata = { title: "Pembelian Bahan Baku" };

export default async function PembelianPage() {
  const user = await requirePerm("stock.view", "accounting.view");
  const [items, suppliers, banks, purchases] = await Promise.all([
    prisma.item.findMany({ where: { active: true, type: "BAHAN_BAKU" }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.purchase.findMany({ include: { lines: { include: { item: true } } }, orderBy: { date: "desc" }, take: 50 }),
  ]);
  const payables = await prisma.payable.findMany({ where: { id: { in: purchases.map((p) => p.payableId).filter((x): x is string => !!x) } } });
  return (
    <div className="space-y-5">
      <PageHeader title="Pembelian bahan baku" subtitle="Satu supplier, banyak item. Nominal kurang dari tagihan otomatis jadi hutang. Stok, jurnal, dan utang tercatat sekaligus." actions={user.can("finance.approve") && (
        <Modal trigger="+ Pembelian" title="Pembelian baru" wide>
          <ModalForm action={savePurchase}>
            <PurchaseFields items={items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, unit: i.unit, lastCost: latestCost(i) }))} suppliers={suppliers} banks={banks} today={todayStr()} defaultBank={banks.find((b) => b.code === "SEABANK")?.id} />
            <div className="mt-4"><Submit>Simpan pembelian</Submit></div>
          </ModalForm>
        </Modal>
      )} />
      {purchases.length === 0 ? <Empty title="Belum ada pembelian" /> : (
        <Card title="Riwayat pembelian">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Supplier</th><th>Item</th><th className="num">Tagihan</th><th className="num">Dibayar</th><th>Status</th><th>Bukti</th></tr></thead>
              <tbody>
                {purchases.map((p) => {
                  const pay = payables.find((x) => x.id === p.payableId);
                  const rem = pay ? Number(pay.amount - pay.paid) : 0;
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.number}</td><td>{fmtDate(p.date)}</td><td>{p.vendor}</td>
                      <td className="text-xs">{p.lines.map((l) => `${l.item.name} × ${Number(l.qty).toLocaleString("id-ID")}`).join(", ")}</td>
                      <td className="num">{idr(p.total)}</td><td className="num">{idr(p.paidNow)}</td>
                      <td>{pay ? (rem > 0 ? <Link href="/akuntansi/piutang-utang?tab=utang"><Badge tone={pay.dueDate && pay.dueDate < new Date() ? "red" : "amber"}>Hutang {idr(rem)} · {fmtDate(pay.dueDate)}</Badge></Link> : <Badge tone="green">Lunas</Badge>) : <Badge tone="green">Lunas</Badge>}</td>
                      <td>{p.proofPath ? <ProofPreview src={`/api/files/purchase-proof/${p.id}`} mime={p.proofMime} title={`Bukti ${p.number}`} /> : <span className="text-slate-400">-</span>}</td>
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
