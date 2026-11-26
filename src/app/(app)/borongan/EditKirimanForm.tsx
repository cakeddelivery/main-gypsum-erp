"use client";
import { useState } from "react";
import { Submit } from "@/components/ActionForm";
import type { ShipmentView } from "@/lib/boronganFlow";

type Opt = { id: string; name: string };
type ItemOpt = { id: string; name: string; unit: string };

const f = (n: number) => n.toLocaleString("id-ID");
/** Angka bahan ditulis dengan koma desimal (server: titik = ribuan, koma = desimal) */
const decStr = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");

/**
 * Ubah kiriman (Owner / Supervisor / pengelola): semua data kiriman dalam satu form ramah HP.
 * Kiriman selesai/ditutup: hanya catatan & driver. Alasan wajib; stok dikoreksi otomatis lewat mutasi selisih.
 */
export function EditKirimanForm({ view, points, drivers, items, finished, paid }: { view: ShipmentView; points: Opt[]; drivers: Opt[]; items: ItemOpt[]; finished: boolean; paid: boolean }) {
  const free = !!view.resultAtReceipt;
  const lockCore = finished || paid;
  const [mode, setMode] = useState(view.mode);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<{ k: number; item: string; qty: string }[]>([]);
  const allotted = (taskId: string) => view.cells.filter((c) => c.taskId === taskId).reduce((a, c) => a + c.dibagi, 0);
  const single = free || mode === "LANGSUNG";
  const curPoints = view.points.map((p) => p.id);
  const used = new Set([...view.cells.map((c) => c.pointId), ...view.reports.map((r) => r.pointId)]);
  return (
    <div className="space-y-4">
      <input type="hidden" name="shipmentId" value={view.id} />
      {finished && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Kiriman sudah {view.closed ? "ditutup" : "selesai"}: hanya catatan &amp; driver yang bisa diubah.</p>}
      {!finished && paid && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Upah sudah diklaim/dibayar: jumlah, titik &amp; cara kirim terkunci.</p>}

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Tanggal</span>
          <input type="date" name="date" defaultValue={view.date} disabled={finished} className="input" />
        </label>
        <div>
          <span className="label">Cara kirim</span>
          <div className="keep-cols grid grid-cols-2 gap-2">
            {(["DRIVER", "LANGSUNG"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                <input type="radio" name="mode" value={m} checked={mode === m} disabled={lockCore} onChange={() => setMode(m)} /> {m === "DRIVER" ? "Lewat driver" : "Diantar langsung"}
              </label>
            ))}
          </div>
          {lockCore && <input type="hidden" name="mode" value={view.mode} />}
        </div>
        {mode === "DRIVER" && (
          <label className="block">
            <span className="label">Driver</span>
            <select name="driverId" defaultValue={view.driverId ?? ""} className="input">
              <option value="">— tanpa driver —</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        {!view.waitingSupport && (
          <div className="block">
            <span className="label">Titik tujuan</span>
            {single ? (
              <select name="pointId" defaultValue={curPoints[0] ?? ""} disabled={lockCore} className="input">
                {points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <div className="space-y-1">
                {points.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="pointId" value={p.id} defaultChecked={curPoints.includes(p.id)} disabled={lockCore || used.has(p.id)} /> {p.name}{used.has(p.id) && <span className="text-xs text-slate-500">(sudah dibagi)</span>}
                  </label>
                ))}
                {/* Titik yang sudah dibagi tidak bisa dilepas: tetap dikirim walau kotaknya dikunci */}
                {[...used].filter((id) => curPoints.includes(id)).map((id) => <input key={id} type="hidden" name="pointId" value={id} />)}
              </div>
            )}
            {lockCore && curPoints.map((id) => <input key={id} type="hidden" name="pointId" value={id} />)}
          </div>
        )}
      </fieldset>

      {!free && view.tasks.length > 0 && (
        <div>
          <span className="label">Jumlah per jenis (pcs)</span>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full table-fixed text-sm tabular-nums">
              <colgroup><col /><col style={{ width: 84 }} /><col style={{ width: 64 }} /></colgroup>
              <thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-2 py-1 text-left">Jenis</th><th className="px-2 py-1 text-center">Jumlah</th><th className="px-2 py-1 text-right">Min.</th></tr></thead>
              <tbody>
                {view.tasks.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-medium">{t.short}</td>
                    <td className="px-1 py-1"><input name={`t:${t.id}`} inputMode="numeric" defaultValue={t.qty} disabled={lockCore} className="input py-1 text-right" aria-label={`Jumlah ${t.short}`} /></td>
                    <td className="px-2 py-1 text-right text-slate-500">{f(allotted(t.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-slate-500">Min. = sudah dibagi ke pekerja. Bahan resep ikut menyesuaikan otomatis.</p>
        </div>
      )}

      {!view.waitingSupport && (
        <div>
          <span className="label">Bahan yang dikirim</span>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {view.lines.map((l) => {
              const gone = removed.has(l.itemId);
              return (
                <li key={l.itemId} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                  <span className={`min-w-0 flex-1 break-words ${gone ? "text-slate-400 line-through" : ""}`}>{l.name}{l.support ? "" : " (resep)"}</span>
                  {gone ? <input type="hidden" name={`l:${l.itemId}`} value="0" /> : <input name={`l:${l.itemId}`} inputMode="decimal" defaultValue={decStr(l.qty)} disabled={finished} className="input w-24 py-1 text-right" aria-label={`Jumlah ${l.name}`} />}
                  <span className="w-10 shrink-0 text-xs text-slate-500">{l.unit}</span>
                  {!finished && <button type="button" className="btn-secondary btn-sm shrink-0" aria-label={gone ? `Kembalikan ${l.name}` : `Hapus ${l.name}`} onClick={() => setRemoved((s) => { const n = new Set(s); if (n.has(l.itemId)) n.delete(l.itemId); else n.add(l.itemId); return n; })}>{gone ? "↺" : "✕"}</button>}
                </li>
              );
            })}
            {extra.map((x) => (
              <li key={x.k} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <select name="n.item" value={x.item} onChange={(e) => setExtra((xs) => xs.map((y) => (y.k === x.k ? { ...y, item: e.target.value } : y)))} className="input min-w-0 flex-1 py-1">
                  <option value="">— pilih bahan —</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                </select>
                <input name="n.qty" inputMode="decimal" value={x.qty} onChange={(e) => setExtra((xs) => xs.map((y) => (y.k === x.k ? { ...y, qty: e.target.value } : y)))} placeholder="0" className="input w-24 py-1 text-right" aria-label="Jumlah bahan baru" />
                <button type="button" className="btn-secondary btn-sm shrink-0" aria-label="Hapus baris" onClick={() => setExtra((xs) => xs.filter((y) => y.k !== x.k))}>✕</button>
              </li>
            ))}
          </ul>
          {!finished && <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => setExtra((xs) => [...xs, { k: Date.now(), item: "", qty: "" }])}>+ Tambah bahan</button>}
        </div>
      )}

      <label className="block"><span className="label">Catatan</span><textarea name="note" defaultValue={view.note ?? ""} rows={2} className="input" /></label>
      <label className="block"><span className="label">Alasan perubahan (wajib)</span><input name="reason" className="input" required minLength={3} placeholder="mis. ternyata diantar langsung, bukan lewat driver" /></label>
      <p className="text-xs text-slate-500">Stok dikoreksi otomatis dengan mutasi selisih (mutasi lama tidak dihapus). Pindah titik/cara kirim: bahan kembali dari lokasi lama lalu keluar ke lokasi baru. Tercatat di riwayat perubahan (lama → baru).</p>
      <Submit confirm="Simpan perubahan kiriman? Stok disesuaikan dan tercatat di riwayat.">Simpan perubahan</Submit>
    </div>
  );
}
