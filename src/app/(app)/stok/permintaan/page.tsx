import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { decideRequest } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Permintaan Stok" };
const TONE = { DIAJUKAN: "amber", DISETUJUI: "blue", DITOLAK: "red", DIPENUHI: "green" } as const;

export default async function PermintaanPage() {
  const user = await requirePerm("stock.request", "stock.approve");
  const own = !user.can("stock.approve") && user.divisionId ? { divisionId: user.divisionId } : {};
  const [reqs, locations] = await Promise.all([
    prisma.stockRequest.findMany({ where: own, include: { item: { include: { supplier: true } }, division: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.location.findMany({ orderBy: { code: "asc" } }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Permintaan stok" subtitle="Dibuat otomatis saat laporan shift mencatat stok bahan ≤ batas minimum (jumlah = kekurangan + jumlah order biasa). Ditandai Dipenuhi otomatis saat pembelian bahan itu dicatat." />
      {reqs.length === 0 ? <Empty title="Belum ada permintaan" /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Waktu</th><th>Divisi</th><th>Item</th><th className="num">Qty</th><th>Pemohon</th><th>Status</th><th>Catatan</th>{user.can("stock.approve") && <th>Tindakan</th>}</tr></thead>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.createdAt)}</td><td>{r.division.name}</td><td>{r.item.name}{r.auto && <span className="ml-1"><Badge tone="blue">Otomatis</Badge></span>}{r.item.buyMode === "ONLINE" && r.item.productUrl ? <div><a href={r.item.productUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium underline">🛒 Order online</a></div> : r.item.supplier && <div className="text-xs text-slate-400">{r.item.supplier.name}</div>}</td><td className="num">{Number(r.qty)} {r.item.unit}</td><td>{r.requestedBy}</td>
                  <td><Badge tone={TONE[r.status]}>{r.status}</Badge>{r.decidedBy && <div className="text-xs text-slate-400">{r.decidedBy}</div>}</td><td className="text-xs">{r.note}</td>
                  {user.can("stock.approve") && (
                    <td><div className="flex gap-1">
                      {r.status === "DIAJUKAN" && (
                        <>
                          <ActionForm action={decideRequest}><input type="hidden" name="id" value={r.id} /><Submit className="btn-success btn-sm" name="decision" value="setujui" pendingText="…">Setujui</Submit></ActionForm>
                          <ActionForm action={decideRequest}><input type="hidden" name="id" value={r.id} /><Submit className="btn-secondary btn-sm" name="decision" value="tolak" pendingText="…">Tolak</Submit></ActionForm>
                        </>
                      )}
                      {r.status === "DISETUJUI" && (
                        <Modal trigger="Penuhi" triggerClass="btn-primary btn-sm" title="Penuhi permintaan (transfer stok)">
                          <ModalForm action={decideRequest} className="space-y-3">
                            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="penuhi" />
                            <Field label="Dari lokasi"><select name="fromLocationId" className="input">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
                            <Field label="Ke lokasi"><select name="toLocationId" className="input" defaultValue={locations.find((l) => l.divisionId === r.divisionId)?.id}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
                            <Submit>Transfer & tandai dipenuhi</Submit>
                          </ModalForm>
                        </Modal>
                      )}
                    </div></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
