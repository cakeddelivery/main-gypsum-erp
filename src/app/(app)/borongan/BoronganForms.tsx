"use client";
import { useState } from "react";

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
