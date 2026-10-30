"use client";
import { useState } from "react";

type Opt = { id: string; name: string; unit?: string; stock?: number };

/** Baris barang + jumlah (kirim bahan, kirim hasil, bahan per pcs tugas) */
export function ItemLines({ items, initial = [], qtyLabel = "Jumlah", emptyLabel = "— pilih barang —" }: { items: Opt[]; initial?: { itemId: string; qty: number }[]; qtyLabel?: string; emptyLabel?: string }) {
  const [rows, setRows] = useState(initial.length ? initial.map((r, k) => ({ k, itemId: r.itemId, qty: String(r.qty) })) : [{ k: 0, itemId: "", qty: "" }]);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const it = items.find((x) => x.id === r.itemId);
        return (
          <div key={r.k} className="grid grid-cols-12 items-start gap-2 [&>*]:min-w-0">
            <div className="col-span-12 sm:col-span-7">
              <select name="itemId" value={r.itemId} className="input" onChange={(e) => set(i, { itemId: e.target.value })}>
                <option value="" disabled>{emptyLabel}</option>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ""}</option>)}
              </select>
              {it?.stock !== undefined && <p className="mt-1 text-xs text-slate-500">Stok tersedia {it.stock.toLocaleString("id-ID")} {it.unit}</p>}
            </div>
            <input name="qty" inputMode="decimal" placeholder={`${qtyLabel}${it?.unit ? ` (${it.unit})` : ""}`} value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input col-span-9 sm:col-span-4" />
            <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm col-span-3 sm:col-span-1" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ k: Date.now(), itemId: "", qty: "" }]))}>×</button>
          </div>
        );
      })}
      <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), itemId: "", qty: "" }])}>+ Tambah Baris</button>
    </div>
  );
}

type Worker = { id: string; name: string; pointId: string };
type Task = { id: string; name: string; workerRate: number; coordinatorRate: number; driverRate: number };

/** Setoran hasil: satu tugas & tanggal, jumlah per pekerja di titik terpilih */
export function ResultRows({ points, workers, tasks }: { points: { id: string; name: string }[]; workers: Worker[]; tasks: Task[] }) {
  const [pointId, setPointId] = useState(points[0]?.id ?? "");
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [qty, setQty] = useState<Record<string, string>>({});
  const list = workers.filter((w) => w.pointId === pointId);
  const task = tasks.find((t) => t.id === taskId);
  const total = list.reduce((s, w) => s + (Number(qty[w.id]) || 0), 0);
  const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
  return (
    <div className="space-y-3">
      {points.length > 1 ? (
        <label className="block"><span className="label">Titik</span>
          <select name="pointId" value={pointId} onChange={(e) => setPointId(e.target.value)} className="input">{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
      ) : <input type="hidden" name="pointId" value={pointId} />}
      <label className="block"><span className="label">Tugas</span>
        <select name="taskId" value={taskId} onChange={(e) => setTaskId(e.target.value)} className="input">{tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </label>
      {task && <p className="text-xs text-slate-500">Per pcs: pekerja {rp(task.workerRate)}, koordinator {rp(task.coordinatorRate)}, driver {rp(task.driverRate)}</p>}
      <div className="rounded-xl border border-slate-200 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Jumlah Hasil Per Pekerja (pcs)</p>
        {list.length === 0 ? <p className="text-sm text-slate-500">Belum ada pekerja aktif di titik ini. Tambahkan dulu di tab Orang.</p> : (
          <div className="space-y-2">
            {list.map((w) => (
              <label key={w.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
                <input name={`qty_${w.id}`} inputMode="numeric" value={qty[w.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [w.id]: e.target.value }))} className="input w-28 text-right" placeholder="0" />
              </label>
            ))}
            <p className="text-right text-sm">Total <b>{total.toLocaleString("id-ID")} pcs</b>{task ? <> · upah pekerja {rp(total * task.workerRate)}</> : null}</p>
          </div>
        )}
      </div>
    </div>
  );
}
