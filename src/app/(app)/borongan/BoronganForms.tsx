"use client";
import { useState } from "react";
import { ItemLines } from "@/components/ItemLines";

type Worker = { id: string; name: string; pointId: string; taskIds?: string[] };
type Task = { id: string; name: string; workerRate: number; coordinatorRate: number; driverRate: number };

/** Setoran hasil: satu tugas & tanggal, jumlah per pekerja di titik terpilih */
export function ResultRows({ points, workers, tasks: allTasks, pointTasks = {}, capacity = {} }: { points: { id: string; name: string }[]; workers: Worker[]; tasks: Task[]; pointTasks?: Record<string, string[]>; capacity?: Record<string, Record<string, number | null>> }) {
  const [pointId, setPointIdRaw] = useState(points[0]?.id ?? "");
  const forPoint = (pid: string) => (pointTasks[pid]?.length ? allTasks.filter((t) => pointTasks[pid].includes(t.id)) : allTasks);
  const tasks = forPoint(pointId);
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const setPointId = (pid: string) => {
    setPointIdRaw(pid);
    const ts = forPoint(pid);
    if (!ts.some((t) => t.id === taskId)) setTaskId(ts[0]?.id ?? "");
  };
  const [qty, setQty] = useState<Record<string, string>>({});
  const [rej, setRej] = useState<Record<string, string>>({});
  // Hanya pekerja titik ini yang mengerjakan tugas terpilih (pekerja tanpa jenis pekerjaan = semua tugas)
  const list = workers.filter((w) => w.pointId === pointId && (!w.taskIds?.length || w.taskIds.includes(taskId)));
  const task = tasks.find((t) => t.id === taskId);
  const total = list.reduce((s, w) => s + (Number(qty[w.id]) || 0), 0);
  const totalRej = list.reduce((s, w) => s + (Number(rej[w.id]) || 0), 0);
  // Sisa bahan di titik (dalam pcs) untuk tugas terpilih; null = tugas tanpa resep bahan
  const cap = capacity[pointId]?.[taskId];
  const left = cap == null ? null : cap - total - totalRej;
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
        {list.length === 0 ? <p className="text-sm text-slate-500">Belum ada pekerja aktif di titik ini untuk {task?.name ?? "tugas ini"}. Atur di menu Borongan › Orang (jenis pekerjaan).</p> : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-slate-500" aria-hidden>
              <span className="min-w-0 flex-1">Pekerja</span><span className="w-20 text-right sm:w-24">Bagus</span><span className="w-20 text-right sm:w-24">Reject</span>
            </div>
            {list.map((w) => (
              <div key={w.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
                <input name={`qty_${w.id}`} aria-label={`Bagus ${w.name}`} inputMode="numeric" value={qty[w.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [w.id]: e.target.value }))} className="input w-20 text-right sm:w-24" placeholder="0" />
                <input name={`rej_${w.id}`} aria-label={`Reject ${w.name}`} inputMode="numeric" value={rej[w.id] ?? ""} onChange={(e) => setRej((q) => ({ ...q, [w.id]: e.target.value }))} className="input w-20 text-right sm:w-24" placeholder="0" />
              </div>
            ))}
            <p className="text-right text-sm">Bagus <b>{total.toLocaleString("id-ID")} pcs</b>{totalRej > 0 && <> · reject <b>{totalRej.toLocaleString("id-ID")} pcs</b></>}{task ? <> · upah pekerja {rp(total * task.workerRate)}</> : null}</p>
            <p className="text-right text-xs text-slate-500">Reject tidak dibayar; bahannya tetap terhitung terpakai.</p>
            {cap != null && (
              <p className={`rounded-lg px-3 py-2 text-sm ${left! < 0 ? "bg-rose-50 text-rose-700" : left === 0 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                Bahan di titik cukup untuk <b>{cap.toLocaleString("id-ID")} pcs</b>.{" "}
                {left! < 0 ? <>Bagus + reject melebihi bahan <b>{(-left!).toLocaleString("id-ID")} pcs</b>.</> : left === 0 ? <>Pas, bahan habis terpakai.</> : <>Setelah setoran ini masih sisa bahan untuk <b>{left!.toLocaleString("id-ID")} pcs</b>.</>}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type Opt = { id: string; name: string; unit?: string; stock?: number };

/** Kirim bahan ke titik: baris paket bahan titik terisi otomatis (jumlah dikosongkan = tidak dikirim), bisa ditambah baris lain */
export function KitSend({ points, items, kits }: { points: { id: string; name: string }[]; items: Opt[]; kits: Record<string, string[]> }) {
  const [pointId, setPointId] = useState(points[0]?.id ?? "");
  const kit = (kits[pointId] ?? []).filter((id) => items.some((i) => i.id === id));
  return (
    <>
      <label className="block"><span className="label">Titik tujuan</span>
        <select name="pointId" value={pointId} onChange={(e) => setPointId(e.target.value)} className="input">{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      {kit.length > 0 && <p className="text-xs text-slate-500">Paket bahan titik ini sudah terisi. Isi jumlah yang dikirim saja; baris yang dikosongkan tidak ikut dikirim.</p>}
      <ItemLines key={pointId} items={items} initial={kit.map((itemId) => ({ itemId, qty: null }))} />
    </>
  );
}
