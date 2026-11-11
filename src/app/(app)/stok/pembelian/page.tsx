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
import { cancelPurchaseAction, savePurchase } from "./actions";
import { Field } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { ProofPreview } from "@/components/ProofPreview";
import { unlinkedReceiptGroups } from "@/lib/shiftReceipt";

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
  const receiptGroups = await unlinkedReceiptGroups();
  const formItems = items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, unit: i.unit, lastCost: latestCost(i) }));
  const defaultBank = banks.find((b) => b.code === "SEABANK")?.id;
  return (
    <div className="space-y-5">
      <PageHeader title="Pembelian bahan baku" subtitle="Satu supplier, banyak item. Nominal kurang dari tagihan otomatis jadi hutang. Stok, jurnal, dan hutang tercatat sekaligus." actions={user.can("finance.approve") && (
        <Modal trigger="+ Pembelian" title="Pembelian baru" wide>
          <ModalForm action={savePurchase}>
            <PurchaseFields items={formItems} suppliers={suppliers} banks={banks} today={todayStr()} defaultBank={defaultBank} />
            <div className="mt-4"><Submit>Simpan pembelian</Submit></div>
          </ModalForm>
        </Modal>
      )} />
      {receiptGroups.length > 0 && (
        <Card title={`Barang masuk dari laporan shift · belum dicatat pembeliannya (${receiptGroups.reduce((a, g) => a + g.rows.length, 0)})`}>
          <p className="mb-3 text-sm text-slate-500">Barang ini sudah ada di gudang dan sudah ikut dihitung di stok akhir shift. Catat pembeliannya (harga & cara bayar) lewat tombol di bawah agar stok & hutang tercatat tanpa dobel.</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {receiptGroups.map((g) => (
              <li key={g.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p><b>{g.report.division.name}</b> · {fmtDate(g.report.date)} · {g.report.shift.name}{g.supplierName && <> · toko <b>{g.supplierName}</b></>}</p>
                  <ul className="mt-1 text-xs text-slate-600">
                    {g.rows.map((x) => (
                      <li key={x.id} className="flex items-center gap-2">
                        <span className="font-mono">{x.number}</span> {x.item.name}: {Number(x.qty).toLocaleString("id-ID")} {x.item.unit}
                        {x.photoPath && <ProofPreview src={`/api/files/receipt/${x.id}`} mime={x.photoMime} title={`Nota ${x.number}`} />}
                      </li>
                    ))}
                  </ul>
                </div>
                {user.can("finance.approve") && (
                  <Modal trigger="Catat pembelian" triggerClass="btn-primary btn-sm" title="Pembelian dari barang masuk" wide>
                    <ModalForm action={savePurchase}>
                      <PurchaseFields
                        items={formItems}
                        suppliers={suppliers}
                        banks={banks}
                        today={g.report.date.toISOString().slice(0, 10)}
                        defaultBank={defaultBank}
                        supplierHint={g.supplierName}
                        receipts={g.rows.map((x) => ({ receiptId: x.id, itemId: x.itemId, qty: Number(x.qty), label: `Barang masuk ${x.number} (${g.report.division.name})` }))}
                      />
                      <div className="mt-4"><Submit>Simpan pembelian</Submit></div>
                    </ModalForm>
                  </Modal>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {purchases.length === 0 ? <Empty title="Belum ada pembelian" /> : (
        <Card title="Riwayat pembelian">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Supplier</th><th>Item</th><th className="num">Tagihan</th><th className="num">Dibayar</th><th>Status</th><th>Bukti</th><th /></tr></thead>
              <tbody>
                {purchases.map((p) => {
                  const pay = payables.find((x) => x.id === p.payableId);
                  const rem = pay ? Number(pay.amount - pay.paid) : 0;
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.number}</td><td>{fmtDate(p.date)}</td><td>{p.vendor}</td>
                      <td className="text-xs">{p.lines.map((l) => `${l.item.name} × ${Number(l.qty).toLocaleString("id-ID")}`).join(", ")}</td>
                      <td className="num">{idr(p.total)}</td><td className="num">{idr(p.paidNow)}</td>
                      <td>{p.cancelledAt ? <><Badge tone="gray">Dibatalkan</Badge>{p.cancelReason && <div className="text-xs text-slate-400">{p.cancelReason}</div>}</> : pay ? (rem > 0 ? <Link href="/akuntansi/piutang-utang?tab=utang"><Badge tone={pay.dueDate && pay.dueDate < new Date() ? "red" : "amber"}>Hutang {idr(rem)} · {fmtDate(pay.dueDate)}</Badge></Link> : <Badge tone="green">Lunas</Badge>) : <Badge tone="green">Lunas</Badge>}</td>
                      <td>{p.proofPath ? <ProofPreview src={`/api/files/purchase-proof/${p.id}`} mime={p.proofMime} title={`Bukti ${p.number}`} /> : <span className="text-slate-400">-</span>}</td>
                      <td>{!p.cancelledAt && user.can("finance.approve") && (!pay || pay.paid === BigInt(0)) && (
                        <Modal trigger="Batalkan" triggerClass="btn-secondary btn-sm" title={`Batalkan ${p.number}`}>
                          <ModalForm action={cancelPurchaseAction} className="space-y-3">
                            <input type="hidden" name="id" value={p.id} />
                            <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                            <p className="text-xs text-slate-500">Jurnal pembelian dibalik, bahan keluar lagi dari gudang, dan sisa hutangnya dihapus. Catat ulang bila perlu.</p>
                            <Submit className="btn-danger">Batalkan pembelian</Submit>
                          </ModalForm>
                        </Modal>
                      )}</td>
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
