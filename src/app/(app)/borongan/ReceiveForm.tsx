import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { addDivisionReceipt } from "./actions";
import { pendingAtPoints, receiptItems } from "@/lib/boronganReceipt";

/**
 * Form penerimaan hasil borongan oleh divisi: total diterima per barang (+ reject), tanpa memilih titik.
 * Titik dibagi otomatis dari sisa setoran koordinator; sisa per titik hanya ditampilkan sebagai petunjuk.
 */
export async function ReceiveForm({ divisionId, date }: { divisionId: string; date: string }) {
  const [items, pending] = await Promise.all([receiptItems(divisionId), pendingAtPoints(divisionId)]);
  if (!items.length) return <p className="text-sm text-slate-500">Divisi ini belum punya tugas borongan dengan barang hasil.</p>;
  const f = (n: number) => n.toLocaleString("id-ID");
  return (
    <ModalForm action={addDivisionReceipt} className="space-y-3">
      <input type="hidden" name="divisionId" value={divisionId} />
      <p className="text-xs text-slate-500">Isi total yang <b>benar-benar diterima</b> per barang (gabungan semua titik). Barang pindah dari titik ke gudang. Upah tetap dari catatan koordinator; bila berbeda, selisihnya ditampilkan.</p>
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {items.map((it) => {
          const pts = pending[it.id] ?? [];
          const left = pts.reduce((a, p) => a + p.qty, 0);
          return (
            <div key={it.id} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
              <div className="col-span-12 min-w-0 sm:col-span-6">
                <div className="text-sm font-medium">{it.name}</div>
                <div className="text-xs text-slate-500">Belum diterima: {f(left)} {it.unit}{pts.length > 1 ? ` (${pts.map((p) => `${p.name} ${f(p.qty)}`).join(" · ")})` : ""}</div>
              </div>
              <label className="col-span-6 sm:col-span-3"><span className="sr-only">Diterima</span><input name={`q_${it.id}`} inputMode="numeric" placeholder="Diterima" className="input py-1.5 text-right" /></label>
              <label className="col-span-6 sm:col-span-3"><span className="sr-only">Reject</span><input name={`r_${it.id}`} inputMode="numeric" placeholder="Reject" className="input py-1.5 text-right" /></label>
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Tanggal diterima</span><input type="date" name="date" defaultValue={date} className="input" /></label>
        <label className="block"><span className="label">Catatan</span><input name="note" className="input" /></label>
      </div>
      <p className="text-xs text-slate-500">Reject = rusak saat diterima: tidak masuk gudang, dibuang dari stok titik (beban selisih).</p>
      <Submit>Simpan penerimaan</Submit>
    </ModalForm>
  );
}
