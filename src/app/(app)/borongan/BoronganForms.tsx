"use client";
import { useState } from "react";

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

type KGroup = import("@/lib/boronganKirim").KirimGroup;

/**
 * Kirim bahan: pilih jenis pekerjaan borongan aktif (boleh lebih dari satu) → titik (sesuai pengaturan titik) →
 * jumlah per bahan (satu baris, kosong = tidak dikirim). Satu kali simpan bisa ke beberapa titik.
 * Driver hanya bila ada titik tujuan yang lewat driver.
 */
export function KirimBahan({ groups, kits = {}, drivers }: { groups: KGroup[]; kits?: import("@/lib/boronganKirim").PointKits; drivers: { id: string; name: string }[] }) {
  const [picked, setPicked] = useState<Record<string, boolean>>(() => (groups.length === 1 ? { [groups[0].key]: true } : {}));
  const [off, setOff] = useState<Record<string, boolean>>({}); // "<grup>|<titik>" yang dimatikan
  const [qty, setQty] = useState<Record<string, string>>({});
  const [driverId, setDriverId] = useState(drivers[0]?.id ?? "");
  const pointName = new Map(groups.flatMap((g) => g.points.map((p) => [p.id, p] as const)));
  // Titik → kelompok terpilih & barangnya (gabungan, tanpa dobel)
  const byPoint = new Map<string, { groups: string[]; items: KGroup["items"] }>();
  for (const g of groups) {
    if (!picked[g.key]) continue;
    for (const p of g.points) {
      if (off[`${g.key}|${p.id}`]) continue;
      const cur = byPoint.get(p.id) ?? { groups: [], items: [] };
      cur.groups.push(g.name);
      for (const it of g.items) if (!cur.items.some((x) => x.id === it.id)) cur.items.push(it);
      byPoint.set(p.id, cur);
    }
  }
  const filled = [...byPoint.keys()].map((pid) => [pid, Object.entries(qty).filter(([k, v]) => k.startsWith(`${pid}:`) && Number(v.replace(",", ".")) > 0).length] as const).filter(([, n]) => n > 0);
  const needDriver = filled.some(([pid]) => pointName.get(pid)?.viaDriver);
  const fmt = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });
  if (!groups.length) return <p className="text-sm text-slate-500">Belum ada tugas borongan aktif dengan resep bahan. Atur di tab Tugas & Tarif dan pengaturan titik.</p>;
  const row = (pid: string, it: KGroup["items"][number]) => {
    const k = `${pid}:${it.id}`;
    return (
      <label key={k} className="grid grid-cols-[1fr_6.5rem] items-center gap-2 border-t border-slate-100 px-3 py-2">
        <span className="min-w-0 text-sm">
          <span className="block truncate">{it.name}</span>
          <span className={`text-xs ${it.stock < 0 ? "text-rose-600" : "text-slate-500"}`}>stok {fmt(it.stock)} {it.unit}</span>
        </span>
        <input name={`kq:${k}`} inputMode="decimal" value={qty[k] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [k]: e.target.value }))} placeholder="0" aria-label={`Jumlah ${it.name} ke ${pointName.get(pid)?.name} (${it.unit})`} className={`input py-1.5 text-right ${qty[k] ? "border-brand-400 bg-brand-50" : ""}`} />
      </label>
    );
  };
  return (
    <div className="space-y-3">
      <div>
        <span className="label">Jenis pekerjaan borongan (boleh lebih dari satu)</span>
        <div className="keep-cols grid grid-cols-2 gap-2 sm:grid-cols-3">
          {groups.map((g) => (
            <button key={g.key} type="button" aria-pressed={!!picked[g.key]} onClick={() => setPicked((x) => ({ ...x, [g.key]: !x[g.key] }))} title={`Tugas: ${g.tasks.join(", ")}`}
              className={`rounded-xl border px-2 py-2 text-center text-sm font-semibold transition ${picked[g.key] ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
              {g.name}
              <span className={`block text-[11px] font-normal ${picked[g.key] ? "text-white/85" : "text-slate-500"}`}>{g.points.map((p) => p.name).join(" · ")}</span>
            </button>
          ))}
        </div>
      </div>
      {groups.filter((g) => picked[g.key] && g.points.length > 1).map((g) => (
        <div key={g.key}>
          <span className="label">Titik {g.name} (boleh semuanya)</span>
          <div className="flex flex-wrap gap-2">
            {g.points.map((p) => {
              const on = !off[`${g.key}|${p.id}`];
              return <button key={p.id} type="button" aria-pressed={on} onClick={() => setOff((x) => ({ ...x, [`${g.key}|${p.id}`]: on }))} className={`min-h-10 flex-1 rounded-xl border px-3 text-sm font-semibold ${on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 bg-white text-slate-700"}`}>{p.name}</button>;
            })}
          </div>
        </div>
      ))}
      {byPoint.size === 0 ? (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Pilih jenis pekerjaan dan titik tujuan dulu.</p>
      ) : (
        <div className="space-y-2">
          <span className="label">Jumlah yang dikirim (kosong = tidak dikirim)</span>
          {[...byPoint].map(([pid, v]) => {
            const main = v.items.filter((i) => i.setengahJadi);
            // Bahan pendukung: bahan baku resep + paket bahan titik (tanpa dobel)
            const extra = [...v.items.filter((i) => !i.setengahJadi), ...(kits[pid] ?? []).filter((k) => !v.items.some((i) => i.id === k.id))];
            return (
              <div key={pid} className="overflow-hidden rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center gap-1.5 bg-slate-50 px-3 py-2">
                  <b className="mr-auto text-sm text-slate-800">{pointName.get(pid)?.name}</b>
                  {v.groups.map((g) => <span key={g} className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">{g}</span>)}
                </div>
                {main.map((it) => row(pid, it))}
                {extra.length > 0 && (
                  <details className="border-t border-slate-100" open={main.length === 0}>
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-500">Bahan pendukung titik ({extra.length}: {extra.slice(0, 3).map((i) => i.name).join(", ")}{extra.length > 3 ? ", …" : ""})</summary>
                    {extra.map((it) => row(pid, it))}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
      {needDriver && drivers.length > 0 && (
        <label className="block"><span className="label">Driver</span>
          <select name="driverId" value={driverId} onChange={(e) => setDriverId(e.target.value)} className="input">{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
      )}
      {!needDriver && filled.length > 0 && <p className="text-xs text-slate-500">Titik tujuan diantar langsung, tanpa driver.</p>}
      {filled.length > 0 && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">Dikirim ke {filled.length} titik: {filled.map(([pid, n]) => `${pointName.get(pid)?.name} (${n} bahan)`).join(" · ")}</p>}
    </div>
  );
}
