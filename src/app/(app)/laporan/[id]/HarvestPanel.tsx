import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { VARIANTS } from "@/lib/shiftReport";
import { OVENS, harvestSummary } from "@/lib/shiftHarvest";
import { addHarvestEntry, correctHarvestEntry } from "../actions";

export type HarvestView = { id: string; oven: string; variant: string; good: number; reject: number; at: Date; posted: boolean; createdBy: string; createdById: string; cancelledAt: Date | null; cancelledBy: string | null; cancelReason: string | null; replacesId: string | null };

const jam = (d: Date) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(d);
const n = (x: number) => x.toLocaleString("id-ID");

/** Form "+ Hasil Panen": pilih oven, isi bagus & reject per karakter (jam otomatis) */
export function HarvestForm({ reportId }: { reportId: string }) {
  return (
    <ModalForm action={addHarvestEntry} className="space-y-3">
      <input type="hidden" name="reportId" value={reportId} />
      <fieldset>
        <legend className="label">Oven</legend>
        <div className="grid grid-cols-2 gap-2">
          {OVENS.map((o, i) => (
            <label key={o} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
              <input type="radio" name="oven" value={o} defaultChecked={i === 0} /> {o}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_5.5rem_5.5rem] gap-2 text-xs text-slate-500"><span>Karakter</span><span>Bagus</span><span>Reject</span></div>
        {VARIANTS.map((v) => (
          <div key={v} className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center gap-2">
            <span className="text-sm font-medium">{v}</span>
            <input name={`g.${v}`} inputMode="numeric" pattern="[0-9.]*" placeholder="0" className="input py-1.5" aria-label={`Bagus ${v}`} />
            <input name={`r.${v}`} inputMode="numeric" pattern="[0-9.]*" placeholder="0" className="input py-1.5" aria-label={`Reject ${v}`} />
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Jam dicatat otomatis. Langsung masuk stok: patung cetak berkurang (bagus + reject), patung kering bertambah (bagus).</p>
      <Submit>Simpan hasil panen</Submit>
    </ModalForm>
  );
}

/** Daftar entri panen laporan ini + total; koreksi/batal sesuai hak */
export function HarvestPanel({ reportId, entries, canAdd, sent, userId, manager, defaultOpen }: { reportId: string; entries: HarvestView[]; canAdd: boolean; sent: boolean; userId: string; manager: boolean; defaultOpen?: boolean }) {
  const sum = harvestSummary(entries);
  const canChange = (e: HarvestView) => !e.cancelledAt && (sent ? manager : manager || e.createdById === userId);
  return (
    <section className="card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-800">Hasil panen realtime</h3>
          <p className="text-xs text-slate-500">Tiap entri langsung masuk stok patung kering. Isian panen & reject laporan dihitung otomatis dari entri ini.</p>
        </div>
        {canAdd && (
          <Modal trigger="+ Hasil Panen" title="Hasil panen" subtitle="Isi setiap kali panen keluar oven" defaultOpen={defaultOpen}>
            <HarvestForm reportId={reportId} />
          </Modal>
        )}
      </div>
      <div className="keep-cols mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {VARIANTS.map((v) => (
          <div key={v} className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-xs text-slate-500">{v}</div>
            <div className="font-semibold">{n(sum.byVariant[v].good)}{sum.byVariant[v].reject > 0 && <span className="ml-1 text-xs font-normal text-rose-600">rj {n(sum.byVariant[v].reject)}</span>}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-600">Total: <b>{n(sum.good)}</b> bagus · <b>{n(sum.reject)}</b> reject · {sum.count} entri</p>
      {entries.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {[...entries].reverse().map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${e.cancelledAt ? "text-slate-400" : ""}`}>
              <div className="min-w-0">
                <div><b>{jam(e.at)}</b> · {e.oven} · {e.variant}: <b>{n(e.good)}</b>{e.reject > 0 && <> · reject {n(e.reject)}</>}</div>
                <div className="text-xs text-slate-500">
                  {e.createdBy}{e.replacesId && " · koreksi"}{!e.posted && !e.cancelledAt && " · belum masuk stok (stok terpadu mati)"}
                  {e.cancelledAt && <> · <span className="line-through">dibatalkan</span> {e.cancelledBy}{e.cancelReason && `: ${e.cancelReason}`}</>}
                </div>
              </div>
              {canChange(e) && (
                <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Koreksi entri panen" subtitle={`${jam(e.at)} · ${e.oven} · ${e.variant}`}>
                  <ModalForm action={correctHarvestEntry} className="space-y-3">
                    <input type="hidden" name="id" value={e.id} />
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block"><span className="label">Bagus</span><input name="good" inputMode="numeric" defaultValue={e.good} className="input" /></label>
                      <label className="block"><span className="label">Reject</span><input name="reject" inputMode="numeric" defaultValue={e.reject} className="input" /></label>
                    </div>
                    <label className="block"><span className="label">Alasan{sent ? " (wajib)" : ""}</span><input name="reason" required={sent} className="input" /></label>
                    <p className="text-xs text-slate-500">Entri lama dibalik dari stok lalu entri baru diposting (tidak dihapus).</p>
                    <div className="flex flex-wrap gap-2">
                      <Submit name="mode" value="koreksi">Simpan koreksi</Submit>
                      <Submit name="mode" value="batal" className="btn-danger" confirm="Batalkan entri panen ini? Stok dikembalikan.">Batalkan entri</Submit>
                    </div>
                  </ModalForm>
                </Modal>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
