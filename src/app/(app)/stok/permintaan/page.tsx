import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { createRequest, decideRequest } from "../actions";

export const metadata = { title: "Permintaan Stok" };
const TONE = { DIAJUKAN: "amber", DISETUJUI: "blue", DITOLAK: "red", DIPENUHI: "green" } as const;

export default async function PermintaanPage() {
  const user = await requirePerm("stock.request", "stock.approve");
  const own = !user.can("stock.approve") && user.divisionId ? { divisionId: user.divisionId } : {};
  const [reqs, items, divisions, locations] = await Promise.all([
    prisma.stockRequest.findMany({ where: own, include: { item: true, division: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.item.findMany({ where: { active: true }, orderBy: { sku: "asc" } }),
    prisma.division.findMany({ where: { active: true } }),
    prisma.location.findMany({ orderBy: { code: "asc" } }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Permintaan stok" subtitle="Divisi mengajukan kebutuhan bahan; gudang menyetujui & memenuhi" />
      {user.can("stock.request") && (
        <Card title="Ajukan permintaan">
          <ActionForm action={createRequest} resetOnSuccess className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Field label="Item" className="col-span-2"><select name="itemId" className="input">{items.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>)}</select></Field>
            <Field label="Divisi"><select name="divisionId" defaultValue={user.divisionId ?? ""} className="input">{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Jumlah"><input name="qty" inputMode="decimal" className="input" required /></Field>
            <Field label="Catatan"><input name="note" className="input" /></Field>
            <div className="col-span-2 md:col-span-5"><Submit>Ajukan</Submit></div>
          </ActionForm>
        </Card>
      )}
      {reqs.length === 0 ? <Empty title="Belum ada permintaan" /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Waktu</th><th>Divisi</th><th>Item</th><th className="num">Qty</th><th>Pemohon</th><th>Status</th><th>Catatan</th>{user.can("stock.approve") && <th>Tindakan</th>}</tr></thead>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.createdAt)}</td><td>{r.division.name}</td><td>{r.item.name}</td><td className="num">{Number(r.qty)} {r.item.unit}</td><td>{r.requestedBy}</td>
                  <td><Badge tone={TONE[r.status]}>{r.status}</Badge>{r.decidedBy && <div className="text-xs text-slate-400">{r.decidedBy}</div>}</td><td className="text-xs">{r.note}</td>
                  {user.can("stock.approve") && (
                    <td className="flex gap-1">
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
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
