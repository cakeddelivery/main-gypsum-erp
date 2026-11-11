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
import { cancelPurchaseAction, closePurchaseAction, receivePurchaseAction, savePurchase } from "./actions";
import { pendingDeliveries, prepaidLeft } from "@/lib/purchaseReceive";
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
    prisma.purchase.findMany({ include: { lines: { include: { item: true } }, _count: { select: { deliveries: true } } }, orderBy: { date: "desc" }, take: 50 }),
  ]);
  const payables = await prisma.payable.findMany({ where: { id: { in: purchases.map((p) => p.payableId).filter((x): x is string => !!x) } } });
  const receiptGroups = await unlinkedReceiptGroups();
  const pending = await pendingDeliveries();
  // Hutang dari penerimaan barang pesanan (bisa lebih dari satu per pesanan)
  const rcPayables = await prisma.payable.findMany({ where: { id: { in: (await prisma.purchaseReceipt.findMany({ where: { purchaseId: { in: purchases.map((p) => p.id) }, payableId: { not: null } }, select: { payableId: true } })).map((r) => r.payableId!) } }, select: { id: true, amount: true, paid: true, dueDate: true, note: true } });
  const qtyFmt = (n: number) => n.toLocaleString("id-ID");
  const formItems = items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, unit: i.unit, lastCost: latestCost(i) }));
  const defaultBank = banks.find((b) => b.code === "SEABANK")?.id;
  return (
    <div className="space-y-5">
      <PageHeader title="Pembelian bahan baku" subtitle="Satu supplier, banyak item. Barang sudah diterima: stok, jurnal & hutang tercatat sekaligus. Barang masih dikirim (bayar dulu / COD): stok masuk saat Terima barang." actions={user.can("finance.approve") && (
        <Modal trigger="+ Pembelian" title="Pembelian baru" wide>
          <ModalForm action={savePurchase}>
            <PurchaseFields items={formItems} suppliers={suppliers} banks={banks} today={todayStr()} defaultBank={defaultBank} />
            <div className="mt-4"><Submit>Simpan pembelian</Submit></div>
          </ModalForm>
        </Modal>
      )} />
      {pending.length > 0 && (
        <Card title={`Pesanan dalam pengiriman · menunggu barang datang (${pending.length})`}>
          <p className="mb-3 text-sm text-slate-500">Stok belum bertambah. Saat barang datang, Supervisor/Kapten menekan <b>Terima barang</b> dan mengisi jumlah yang benar-benar datang (boleh sebagian). Bisa juga dari Barang masuk di laporan shift.</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {pending.map((p) => {
              const left = prepaidLeft(p);
              return (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p><span className="font-mono text-xs">{p.number}</span> · {fmtDate(p.date)} · <b>{p.vendor}</b> · {idr(p.total)} {p.cod ? <Badge tone="amber">COD</Badge> : Number(p.paidNow) >= Number(p.total) ? <Badge tone="green">Lunas di depan</Badge> : Number(p.paidNow) > 0 ? <Badge tone="blue">DP {idr(p.paidNow)}</Badge> : <Badge tone="amber">Belum dibayar</Badge>} {p.delivery === "SEBAGIAN" && <Badge tone="blue">Datang sebagian</Badge>}</p>
                    <ul className="mt-1 text-xs text-slate-600">
                      {p.lines.map((l) => <li key={l.id}>{l.item.name}: datang {qtyFmt(Number(l.qtyReceived))} dari {qtyFmt(Number(l.qty))} {l.item.unit}</li>)}
                    </ul>
                    <p className="mt-1 text-xs text-slate-600">
                      Dibayar {idr(p.paidNow + p.codPaid)} · barang datang senilai {idr(p.deliveries.reduce((t, d) => t + Number(d.value), 0))}
                      {left > 0 && <> · <b className="text-sky-700">supplier masih berhutang barang senilai {idr(left)}</b> (uang muka)</>}
                      {!p.cod && Number(p.total) > Number(p.paidNow) && <> · sisa {idr(Number(p.total) - Number(p.paidNow))} jadi hutang saat barangnya datang</>}
                    </p>
                    {p.deliveries.length > 0 && <p className="mt-1 text-xs text-slate-400">Penerimaan: {p.deliveries.map((d) => `${d.number} (${fmtDate(d.date)}, ${d.receivedBy})`).join(", ")}</p>}
                  </div>
                  <div className="flex gap-1">
                    {user.can("stock.receive") && (
                      <Modal trigger="Terima barang" triggerClass="btn-primary btn-sm" title={`Terima barang ${p.number}`}>
                        <ModalForm action={receivePurchaseAction} className="space-y-3">
                          <input type="hidden" name="purchaseId" value={p.id} />
                          <Field label="Tanggal datang"><input type="date" name="date" defaultValue={todayStr()} className="input" required /></Field>
                          {p.lines.filter((l) => Number(l.qty) - Number(l.qtyReceived) > 0.0005).map((l) => (
                            <Field key={l.id} label={`${l.item.name} — jumlah datang (${l.item.unit})`} hint={`Sisa pesanan ${qtyFmt(Number(l.qty) - Number(l.qtyReceived))} ${l.item.unit}. Isi 0 bila belum datang.`}>
                              <input type="hidden" name="lineId" value={l.id} />
                              <input name="recvQty" inputMode="decimal" defaultValue={String(Number(l.qty) - Number(l.qtyReceived)).replace(".", ",")} className="input" required />
                            </Field>
                          ))}
                          {p.cod && <Field label="Dibayar COD dari" hint="Rekening/dompet yang dipakai membayar kurir"><select name="bankAccountId" className="input" defaultValue={banks.find((b) => b.code === "KAS")?.id ?? defaultBank}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
                          {!p.cod && left <= 0 && <p className="text-xs text-amber-700">Pesanan ini belum dibayar: nilai barang yang datang otomatis jadi hutang ke {p.vendor}.</p>}
                          <Field label="Foto barang / nota (opsional)"><input type="file" name="photo" accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full text-base" /></Field>
                          <Field label="Catatan"><input name="note" className="input" placeholder="cth: 2 sak sobek" /></Field>
                          <Submit>Simpan penerimaan</Submit>
                        </ModalForm>
                      </Modal>
                    )}
                    {user.can("finance.approve") && (
                      <Modal trigger="Tutup" triggerClass="btn-secondary btn-sm" title={`Tutup pesanan ${p.number}`}>
                        <ModalForm action={closePurchaseAction} className="space-y-3">
                          <input type="hidden" name="id" value={p.id} />
                          <p className="text-sm text-slate-600">Dipakai bila sisa barang tidak akan datang. Barang yang sudah diterima tetap tercatat.{left > 0 && <> Uang muka sisa <b>{idr(left)}</b> dicatat sebagai piutang refund dari {p.vendor}.</>}</p>
                          <Field label="Alasan"><input name="reason" className="input" required placeholder="cth: stok penjual habis, dana dikembalikan" /></Field>
                          <Submit className="btn-danger">Tutup pesanan</Submit>
                        </ModalForm>
                      </Modal>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
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
                      <td className="num">{idr(p.total)}</td><td className="num">{idr(p.paidNow + p.codPaid)}</td>
                      <td>{!p.cancelledAt && p.delivery !== "DITERIMA" && <div className="mb-1"><Badge tone={p.delivery === "DITUTUP" ? "gray" : "blue"}>{p.delivery === "MENUNGGU" ? "Dikirim" : p.delivery === "SEBAGIAN" ? "Datang sebagian" : "Ditutup"}</Badge></div>}
                        {!p.cancelledAt && rcPayables.filter((x) => x.note?.includes(p.number) && x.amount > x.paid).map((x) => <div key={x.id}><Link href="/akuntansi/piutang-utang?tab=utang"><Badge tone="amber">Hutang {idr(Number(x.amount - x.paid))}</Badge></Link></div>)}
                        {p.cancelledAt ? <><Badge tone="gray">Dibatalkan</Badge>{p.cancelReason && <div className="text-xs text-slate-400">{p.cancelReason}</div>}</> : pay ? (rem > 0 ? <Link href="/akuntansi/piutang-utang?tab=utang"><Badge tone={pay.dueDate && pay.dueDate < new Date() ? "red" : "amber"}>Hutang {idr(rem)} · {fmtDate(pay.dueDate)}</Badge></Link> : <Badge tone="green">Lunas</Badge>) : <Badge tone="green">Lunas</Badge>}</td>
                      <td>{p.proofPath ? <ProofPreview src={`/api/files/purchase-proof/${p.id}`} mime={p.proofMime} title={`Bukti ${p.number}`} /> : <span className="text-slate-400">-</span>}</td>
                      <td>{!p.cancelledAt && p._count.deliveries === 0 && user.can("finance.approve") && (!pay || pay.paid === BigInt(0)) && (
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
