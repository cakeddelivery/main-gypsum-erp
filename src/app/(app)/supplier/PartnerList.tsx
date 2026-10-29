import { Badge, Empty, FilterBar, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import type { ActionResult } from "@/lib/action";

type Row = { id: string; name: string; phone: string | null; address: string | null; note: string | null; active: boolean; extra?: React.ReactNode };
type Act = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** Daftar supplier / pelanggan: cari, tambah, ubah, hapus (form berupa popup) */
export function PartnerList({ kind, subtitle, rows, q, canManage, save, remove, extraHeader }: { kind: "Supplier" | "Pelanggan"; subtitle: string; rows: Row[]; q?: string; canManage: boolean; save: Act; remove: Act; extraHeader?: string }) {
  const form = (r?: Row) => (
    <ModalForm action={save} className="space-y-3">
      {r && <input type="hidden" name="id" value={r.id} />}
      <Field label="Nama"><input name="name" defaultValue={r?.name} className="input" required /></Field>
      <Field label="No. HP / WhatsApp"><input name="phone" type="tel" defaultValue={r?.phone ?? ""} className="input" /></Field>
      <Field label="Alamat"><input name="address" defaultValue={r?.address ?? ""} className="input" /></Field>
      <Field label="Catatan"><input name="note" defaultValue={r?.note ?? ""} className="input" /></Field>
      {r && <Field label="Status"><select name="active" defaultValue={r.active ? "true" : "false"} className="input"><option value="true">Aktif</option><option value="false">Nonaktif</option></select></Field>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );
  const wa = (phone: string) => phone.replace(/\D/g, "").replace(/^0/, "62");
  return (
    <div className="space-y-4">
      <PageHeader title={kind} subtitle={subtitle} actions={canManage && <Modal trigger={`+ ${kind}`} title={`${kind} baru`}>{form()}</Modal>} />
      <FilterBar>
        <Field label="Cari" className="col-span-2"><input name="q" defaultValue={q} className="input" placeholder="Nama / no. HP / alamat" /></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title={q ? `${kind} tidak ditemukan` : `Belum ada ${kind.toLowerCase()}`} hint={canManage ? `Tekan + ${kind} untuk menambah.` : undefined} /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Nama</th><th>No. HP</th><th>Alamat</th><th>Catatan</th>{extraHeader && <th>{extraHeader}</th>}<th>Status</th>{canManage && <th />}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.active ? "" : "opacity-60"}>
                  <td className="font-medium text-slate-900">{r.name}</td>
                  <td>{r.phone ? <a className="link" href={`https://wa.me/${wa(r.phone)}`} target="_blank" rel="noreferrer">{r.phone}</a> : "—"}</td>
                  <td className="max-w-xs truncate">{r.address ?? "—"}</td>
                  <td className="max-w-xs truncate text-xs">{r.note ?? ""}</td>
                  {extraHeader && <td>{r.extra}</td>}
                  <td>{r.active ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</td>
                  {canManage && (
                    <td>
                      <div className="flex gap-1">
                        <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${kind.toLowerCase()}`}>{form(r)}</Modal>
                        <ActionForm action={remove} confirm={`Hapus ${r.name}?`}><input type="hidden" name="id" value={r.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>
                      </div>
                    </td>
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
