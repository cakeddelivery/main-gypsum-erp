import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { KIND_LABEL, type Matrix } from "@/lib/marketplace/kelengkapan";
import type { syncStatus } from "@/lib/marketplace/sync";
import { Badge, Field } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { AccessGapForm } from "./Kelengkapan";
import { clearAccessGapAction, saveBrandMapAction, saveSyncAction, saveWdHourAction } from "./actions";

/** Tombol "⚙ Pengaturan" di header dashboard: tanggal mulai & jam pengingat, jam pengingat withdraw, akses belum tersedia, merek → toko */
export function PengaturanMarketplace({ sync, wdHour, matrix, stores, brands }: {
  sync: Awaited<ReturnType<typeof syncStatus>>; wdHour: number; matrix: Matrix; stores: { id: string; name: string }[]; brands: Map<string, string[]>;
}) {
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  return (
    <Modal trigger="⚙ Pengaturan" triggerClass="btn-secondary" title="Pengaturan marketplace" subtitle="Pembaruan data, pengingat, akses, dan pengenalan toko" wide>
      <div className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="font-semibold">Pembaruan data & pengingat</h3>
          <p className="text-xs text-slate-500">Mulai tanggal ini data wajib diunggah (kelengkapan per bulan ditagih dari tanggal ini sampai kemarin). Pengingat ke Supervisor pada jam ini; Owner 2 jam kemudian bila belum lengkap.</p>
          <ActionForm action={saveSyncAction} className="flex flex-wrap items-end gap-2">
            <Field label="Wajib diperbarui mulai tanggal"><input type="date" name="start" defaultValue={sync.start ?? ""} className="input" /></Field>
            <Field label="Pengingat pukul"><input type="number" name="hour" min={0} max={21} defaultValue={sync.hour} className="input w-24" /></Field>
            <Submit className="btn-secondary">Simpan</Submit>
          </ActionForm>
          <p className="text-xs text-slate-500">Kosongkan tanggal untuk mematikan tuntutan harian. {sync.active ? (sync.stale ? `${sync.stale} data belum diperbarui hari ini.` : "Semua data sudah diperbarui.") : "Belum aktif."}</p>
          <ActionForm action={saveWdHourAction} className="flex flex-wrap items-end gap-2">
            <Field label="Pengingat withdraw ke Finance & Owner pukul"><input name="hour" type="number" min={0} max={23} defaultValue={wdHour} className="input w-24" /></Field>
            <Submit className="btn-secondary">Simpan</Submit>
          </ActionForm>
        </section>

        <section className="space-y-2 border-t pt-4">
          <h3 className="font-semibold">Akses belum tersedia</h3>
          <p className="text-xs text-slate-500">Jenis file yang untuk sementara tidak bisa diunduh: pengingatnya dijeda sampai tanggal tinjau, Piutang toko itu diberi peringatan, Cek Integritas menandai ⚠.</p>
          {matrix.gaps.length > 0 && (
            <ul className="space-y-1">
              {matrix.gaps.map((g) => (
                <li key={g.storeId + g.channel + g.kind} className="flex flex-wrap items-center gap-2">
                  <Badge tone={g.paused ? "gray" : "amber"}>{g.paused ? "Menunggu akses" : "Waktunya tinjau"}</Badge>
                  <span>{sn.get(g.storeId)} · {CHANNEL_LABEL[g.channel]} · {KIND_LABEL[g.kind]} — tinjau {g.reviewAt}{g.note ? ` · ${g.note}` : ""}</span>
                  <ActionForm action={clearAccessGapAction} className="inline">
                    <input type="hidden" name="storeId" value={g.storeId} /><input type="hidden" name="channel" value={g.channel} /><input type="hidden" name="kind" value={g.kind} />
                    <Submit className="btn-secondary btn-sm" pendingText="…">Akses sudah tersedia</Submit>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <AccessGapForm stores={stores} />
        </section>

        <section className="space-y-2 border-t pt-4">
          <h3 className="font-semibold">Merek → toko</h3>
          <p className="text-xs text-slate-500">Dipakai mengenali toko file pesanan yang tidak memuat nama toko: bila ≥80% nama produk diawali merek ini, toko ditebak otomatis. Pisahkan beberapa merek dengan koma. Bawaan: nama toko.</p>
          <ActionForm action={saveBrandMapAction} className="space-y-2">
            {stores.map((s) => <Field key={s.id} label={s.name}><input name={`brand:${s.id}`} className="input" defaultValue={(brands.get(s.id) ?? []).join(", ")} placeholder="mis. MAIN GYPSUM" /></Field>)}
            <Submit className="btn-secondary">Simpan</Submit>
          </ActionForm>
        </section>
      </div>
    </Modal>
  );
}
