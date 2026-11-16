"use client";
import { useMemo, useState } from "react";
import { Submit } from "@/components/ActionForm";
import type { CellView, PickupView, ShipmentView } from "@/lib/boronganFlow";

/**
 * Form HP alur kiriman borongan. Setiap pekerja = satu tabel kecil: kolom Status | jenis (Cowok/Cewek/…),
 * baris Dibagi / Diambil / Setoran / Reject / Sisa. Tabel bergeser di dalam kartunya sendiri (lebar HP 360 px).
 */

const f = (n: number) => n.toLocaleString("id-ID");
const toInt = (s: string | undefined) => {
  const n = Number(String(s ?? "").replace(/\./g, "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
type Task = ShipmentView["tasks"][number];

function NumIn({ name, value, onChange, label }: { name: string; value: string; onChange: (v: string) => void; label: string }) {
  return <input name={name} aria-label={label} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" className="input h-8 w-14 px-1 text-center text-sm font-semibold tabular-nums" />;
}

/** Satu tabel per pekerja */
export function WorkerCard({ name, sub, tasks, rows, footer }: { name: string; sub?: React.ReactNode; tasks: Task[]; rows: { label: string; muted?: boolean; foot?: boolean; cells: (React.ReactNode | null)[] }[]; footer?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-200 px-3 py-2 text-sm font-bold text-slate-900"><span className="break-words">{name}</span>{sub}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500">
              <th className="sticky left-0 bg-slate-50 px-2 py-1.5 text-left font-semibold">Status</th>
              {tasks.map((t) => <th key={t.id} className="px-1 py-1.5 text-center font-semibold">{t.short}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={`border-t border-slate-100 ${r.foot ? "bg-slate-50 font-bold" : ""}`}>
                <td className={`sticky left-0 whitespace-nowrap px-2 py-1.5 text-left font-semibold ${r.foot ? "bg-slate-50" : "bg-white"} ${r.muted ? "text-slate-500" : "text-slate-800"}`}>{r.label}</td>
                {r.cells.map((c, i) => <td key={tasks[i].id} className={`px-1 py-1 text-center ${r.muted ? "text-slate-500" : ""}`}>{c ?? <span className="text-slate-400">—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

const byWorker = (cells: CellView[], pointId?: string) => {
  const m = new Map<string, { workerId: string; worker: string; pointId: string; cells: CellView[] }>();
  for (const c of cells) {
    if (pointId && c.pointId !== pointId) continue;
    const cur = m.get(c.workerId) ?? { workerId: c.workerId, worker: c.worker, pointId: c.pointId, cells: [] };
    cur.cells.push(c);
    m.set(c.workerId, cur);
  }
  return [...m.values()];
};
const Diff = ({ n, done }: { n: number; done: boolean }) => (done ? (n ? <span className="font-bold text-rose-700">{n}</span> : <span>0</span>) : <span>{f(n)}</span>);

// ---------------- 1. KIRIM BAHAN ----------------

export type KirimGroupOpt = {
  key: string; name: string;
  tasks: { id: string; short: string; bom: { itemId: string; name: string; unit: string; per: number }[] }[];
  points: { id: string; name: string; viaDriver: boolean }[];
  support: { id: string; name: string; unit: string; stock: number }[];
};

export function KirimForm({ groups, drivers, today }: { groups: KirimGroupOpt[]; drivers: { id: string; name: string }[]; today: string }) {
  const [key, setKey] = useState(groups[0]?.key ?? "");
  const g = groups.find((x) => x.key === key);
  const [pts, setPts] = useState<string[]>([]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const chosen = g?.points.filter((p) => pts.includes(p.id)) ?? [];
  const direct = chosen.length === 1 && !chosen[0].viaDriver;
  const [modeRaw, setMode] = useState<"DRIVER" | "LANGSUNG" | null>(null);
  const mode = modeRaw ?? (direct ? "LANGSUNG" : "DRIVER");
  const total = g?.tasks.reduce((a, t) => a + toInt(qty[t.id]), 0) ?? 0;
  const bom = useMemo(() => {
    const m = new Map<string, { name: string; unit: string; qty: number }>();
    for (const t of g?.tasks ?? []) for (const b of t.bom) {
      const cur = m.get(b.itemId) ?? { name: b.name, unit: b.unit, qty: 0 };
      cur.qty += b.per * toInt(qty[t.id]);
      m.set(b.itemId, cur);
    }
    return [...m.values()].filter((x) => x.qty > 0);
  }, [g, qty]);
  if (!groups.length) return <p className="text-sm text-slate-500">Belum ada jenis pekerjaan borongan aktif dengan titik tujuan. Atur di tab Tugas &amp; Tarif.</p>;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Jenis pekerjaan</span>
          <select className="input" value={key} onChange={(e) => { setKey(e.target.value); setPts([]); setQty({}); setMode(null); }}>{groups.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select>
        </label>
        <label className="block"><span className="label">Tanggal</span><input type="date" name="date" defaultValue={today} className="input" /></label>
      </div>
      <fieldset>
        <legend className="label">Titik tujuan</legend>
        <div className="flex flex-wrap gap-2">
          {g?.points.map((p) => (
            <label key={p.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${pts.includes(p.id) ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-300"}`}>
              <input type="checkbox" name="pointId" value={p.id} checked={pts.includes(p.id)} onChange={(e) => { setPts((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id))); setMode(null); }} className="h-4 w-4" />
              {p.name}{!p.viaDriver && <span className="text-xs text-slate-500">(langsung)</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="label">Cara kirim</legend>
        <input type="hidden" name="mode" value={mode} />
        <div className="grid grid-cols-2 gap-2 keep-cols">
          {(["DRIVER", "LANGSUNG"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${mode === m ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-700"}`}>{m === "DRIVER" ? "Lewat driver" : "Diantar langsung"}</button>
          ))}
        </div>
        {mode === "LANGSUNG" && chosen.length > 1 && <p className="mt-1 text-xs text-rose-700">Diantar langsung hanya untuk satu titik.</p>}
      </fieldset>
      {mode === "DRIVER" && drivers.length > 0 && (
        <label className="block"><span className="label">Driver</span><select name="driverId" className="input" defaultValue={drivers[0].id}>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      )}
      <div className="rounded-xl border border-slate-200 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Jumlah per jenis (pcs)</p>
        <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
          {g?.tasks.map((t) => (
            <label key={t.id} className="block"><span className="text-xs font-medium text-slate-600">{t.short}</span>
              <input name={`t:${t.id}`} inputMode="numeric" value={qty[t.id] ?? ""} onChange={(e) => setQty((x) => ({ ...x, [t.id]: e.target.value.replace(/[^\d]/g, "") }))} placeholder="0" className="input text-right tabular-nums" />
            </label>
          ))}
        </div>
        <p className="mt-2 text-right text-sm">Total <b>{f(total)} pcs</b></p>
        {bom.length > 0 && <p className="text-xs text-slate-500">Bahan resep ikut keluar otomatis: {bom.map((b) => `${b.name} ${f(Math.round(b.qty * 1000) / 1000)} ${b.unit}`).join(" · ")}</p>}
      </div>
      {!!g?.support.length && (
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Bahan pendukung</p>
          <div className="space-y-2">
            {g.support.map((i) => (
              <label key={i.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-sm">{i.name} <span className="text-xs text-slate-500">· stok {f(i.stock)} {i.unit}</span></span>
                <input name={`s:${i.id}`} inputMode="decimal" placeholder="0" className="input w-24 text-right tabular-nums" />
              </label>
            ))}
          </div>
        </div>
      )}
      <label className="block"><span className="label">Catatan</span><input name="note" className="input" /></label>
      <p className="text-xs text-slate-500">{mode === "DRIVER" ? "Bahan keluar gudang dan tercatat di mobil driver. Saat driver membagi ke pekerja, bahan tercatat pindah ke titik." : "Bahan keluar gudang langsung ke titik. Pembagian & pengambilan dicatat tim divisi / Supervisor."} Tidak ada lagi konfirmasi terima di titik.</p>
      <Submit>Simpan &amp; kirim</Submit>
    </div>
  );
}

// ---------------- 2. PEMBAGIAN ----------------

export function BagiForm({ view, workers }: { view: ShipmentView; workers: { id: string; name: string; pointId: string; taskIds: string[] }[] }) {
  const init = Object.fromEntries(view.cells.map((c) => [`a:${c.pointId}:${c.workerId}:${c.taskId}`, String(c.dibagi)]));
  const [val, setVal] = useState<Record<string, string>>(init);
  const sum = (taskId: string) => Object.entries(val).filter(([k]) => k.endsWith(`:${taskId}`)).reduce((a, [, v]) => a + toInt(v), 0);
  const left = view.tasks.reduce((a, t) => a + t.qty - sum(t.id), 0);
  const over = view.tasks.some((t) => sum(t.id) > t.qty);
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} />
      {view.points.map((p) => {
        const list = workers.filter((w) => w.pointId === p.id);
        return (
          <div key={p.id} className="rounded-xl border border-slate-200 p-3">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{p.name}</p>
            {!list.length ? <p className="text-sm text-slate-500">Belum ada pekerja aktif di titik ini.</p> : (
              <div className="divide-y divide-slate-100">
                {list.map((w) => {
                  const ts = view.tasks.filter((t) => !w.taskIds.length || w.taskIds.includes(t.id));
                  return (
                    <div key={w.id} className="py-2">
                      <div className="mb-1 break-words text-sm font-semibold text-slate-800">{w.name}</div>
                      <div className="flex flex-wrap gap-2">
                        {ts.map((t) => {
                          const k = `a:${p.id}:${w.id}:${t.id}`;
                          return <label key={t.id} className="flex items-center gap-1 text-xs text-slate-600">{t.short}<NumIn name={k} label={`${w.name} ${t.short}`} value={val[k] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [k]: v }))} /></label>;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <div className="rounded-xl bg-slate-50 p-3 text-sm">
        {view.tasks.map((t) => {
          const d = sum(t.id);
          return <div key={t.id} className="flex justify-between gap-2"><span>{t.short}</span><span className="tabular-nums">dibagi <b>{f(d)}</b> dari {f(t.qty)} · <span className={d > t.qty ? "font-bold text-rose-700" : d < t.qty ? "font-bold text-amber-700" : "text-emerald-700"}>sisa {f(t.qty - d)}</span></span></div>;
        })}
      </div>
      {over && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Pembagian melebihi jumlah kiriman.</p>}
      <Submit confirm={left > 0 ? `Masih ada ${f(left)} pcs yang belum dibagi. Tetap simpan?` : undefined}>Simpan pembagian</Submit>
    </div>
  );
}

// ---------------- 3. LAPOR HASIL ----------------

export function LaporForm({ view, pointId }: { view: ShipmentView; pointId: string }) {
  const groups = byWorker(view.cells, pointId);
  const [val, setVal] = useState<Record<string, string>>(() => Object.fromEntries(view.cells.filter((c) => c.pointId === pointId && c.reported).flatMap((c) => [[`g:${c.workerId}:${c.taskId}`, String(c.good)], [`r:${c.workerId}:${c.taskId}`, String(c.reject)]])));
  const anyReject = Object.entries(val).some(([k, v]) => k.startsWith("r:") && toInt(v) > 0);
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} /><input type="hidden" name="pointId" value={pointId} />
      {!groups.length && <p className="text-sm text-slate-500">Kiriman ini belum dibagi ke pekerja di titik ini.</p>}
      {groups.map((w) => {
        const cell = (t: Task) => w.cells.find((c) => c.taskId === t.id);
        const input = (p: "g" | "r", t: Task) => {
          const c = cell(t);
          if (!c) return null;
          const k = `${p}:${w.workerId}:${t.id}`;
          return <NumIn name={k} label={`${p === "g" ? "Setoran" : "Reject"} ${w.worker} ${t.short}`} value={val[k] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [k]: v }))} />;
        };
        return (
          <WorkerCard key={w.workerId} name={w.worker} tasks={view.tasks} rows={[
            { label: "Dibagi", muted: true, cells: view.tasks.map((t) => (cell(t) ? f(cell(t)!.dibagi) : null)) },
            { label: "Setoran", cells: view.tasks.map((t) => input("g", t)) },
            { label: "Reject", cells: view.tasks.map((t) => input("r", t)) },
            { label: "Sisa", foot: true, cells: view.tasks.map((t) => { const c = cell(t); if (!c) return null; const n = c.dibagi - toInt(val[`g:${w.workerId}:${t.id}`]) - toInt(val[`r:${w.workerId}:${t.id}`]); return <span className={n < 0 ? "text-rose-700" : ""}>{f(n)}</span>; }) },
          ]} />
        );
      })}
      <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold">
        <input type="checkbox" name="checked" className="h-5 w-5" /> Reject sudah dicek koordinator
      </label>
      {anyReject && <p className="text-xs text-slate-500">Reject dihitung pekerja dan dicek koordinator. Reject tidak dibayar dan tidak memotong upah.</p>}
      <p className="text-xs text-slate-500">Angka diisi total sejak kiriman ini dibagi. Boleh lapor lagi besok dengan nomor kiriman yang sama.</p>
      <Submit>Kirim laporan</Submit>
    </div>
  );
}

// ---------------- 4. AMBIL SETORAN ----------------

export function AmbilForm({ view, pointIds }: { view: ShipmentView; pointIds?: string[] }) {
  const groups = byWorker(view.cells).filter((w) => !pointIds || pointIds.includes(w.pointId));
  const [val, setVal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const nth = view.pickups.filter((p) => p.status !== "DIBATALKAN").length + 1;
  const total = Object.values(val).reduce((a, v) => a + toInt(v), 0);
  const pname = (id: string) => view.points.find((p) => p.id === id)?.name ?? "";
  const toggle = (w: (typeof groups)[number], on: boolean) => {
    setDone((d) => ({ ...d, [w.workerId]: on }));
    if (on) setVal((x) => ({ ...x, ...Object.fromEntries(w.cells.filter((c) => !c.done).map((c) => [`q:${c.pointId}:${c.workerId}:${c.taskId}`, String(Math.max(0, c.dibagi - c.diambil - c.reject))])) }));
  };
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} />
      <p className="text-xs text-slate-500">Pengambilan ke-{nth}. Isi setoran <b>bagus</b> saja; reject diambil dari laporan koordinator. Centang <b>Selesai semua</b> bila pekerja sudah menyetor semuanya.</p>
      {groups.map((w) => {
        const open = w.cells.filter((c) => !c.done);
        if (!open.length) return <div key={w.workerId} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold">{w.worker} <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">selesai</span></div>;
        const isDone = !!done[w.workerId];
        const cell = (t: Task) => w.cells.find((c) => c.taskId === t.id && !c.done);
        const k = (c: CellView) => `q:${c.pointId}:${c.workerId}:${c.taskId}`;
        return (
          <WorkerCard key={w.workerId} name={w.worker} sub={view.points.length > 1 ? <span className="text-xs font-medium text-slate-500">· {pname(w.pointId)}</span> : null} tasks={view.tasks} rows={[
            { label: "Dibagi", muted: true, cells: view.tasks.map((t) => (cell(t) ? f(cell(t)!.dibagi) : null)) },
            { label: "Diambil", muted: true, cells: view.tasks.map((t) => (cell(t) ? f(cell(t)!.diambil) : null)) },
            { label: "Setoran", cells: view.tasks.map((t) => { const c = cell(t); return c ? <NumIn name={k(c)} label={`Setoran ${w.worker} ${t.short}`} value={val[k(c)] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [k(c)]: v }))} /> : null; }) },
            { label: "Reject", muted: true, cells: view.tasks.map((t) => { const c = cell(t); return c ? (c.reported ? f(c.reject) : <span className="text-xs text-slate-400">belum</span>) : null; }) },
            { label: isDone ? "Selisih" : "Sisa", foot: true, cells: view.tasks.map((t) => { const c = cell(t); return c ? <Diff n={c.dibagi - c.diambil - toInt(val[k(c)]) - c.reject} done={isDone} /> : null; }) },
          ]} footer={
            <label className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-sm font-semibold">
              <input type="checkbox" name={`d:${w.workerId}`} checked={isDone} onChange={(e) => toggle(w, e.target.checked)} className="h-5 w-5" /> Selesai semua
            </label>
          } />
        );
      })}
      <p className="text-right text-sm">Total setoran dibawa <b>{f(total)} pcs</b></p>
      <Submit>Bawa ke workshop</Submit>
    </div>
  );
}

// ---------------- 5. TERIMA SETORAN ----------------

export function TerimaForm({ pickup, tasks }: { pickup: PickupView; tasks: Task[] }) {
  const used = tasks.filter((t) => pickup.lines.some((l) => l.taskId === t.id));
  const driver = (id: string) => pickup.lines.filter((l) => l.taskId === id).reduce((a, l) => a + l.qty, 0);
  const [val, setVal] = useState<Record<string, string>>({});
  const filled = used.every((t) => (val[t.id] ?? "") !== "");
  const short = filled && used.some((t) => toInt(val[t.id]) < driver(t.id));
  return (
    <div className="space-y-3">
      <input type="hidden" name="pickupId" value={pickup.id} />
      <p className="text-xs text-slate-500">Hitung <b>total</b> setoran per jenis. Rincian per pekerja diambil dari catatan driver.</p>
      <WorkerCard name="Total pengambilan ini" tasks={used} rows={[
        { label: "Setoran driver", muted: true, cells: used.map((t) => f(driver(t.id))) },
        { label: "Dihitung", cells: used.map((t) => <NumIn key={t.id} name={`c:${t.id}`} label={`Dihitung ${t.short}`} value={val[t.id] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [t.id]: v }))} />) },
        { label: "Selisih", foot: true, cells: used.map((t) => ((val[t.id] ?? "") === "" ? "" : <Diff n={toInt(val[t.id]) - driver(t.id)} done />)) },
      ]} />
      {filled && <p className={`rounded-lg px-3 py-2 text-sm ${short ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{short ? "Hitungan kurang dari setoran driver: upah pengambilan ini ditahan, driver & Supervisor diberi notifikasi." : "Cocok: barang masuk gudang, upah per pekerja mengikuti setoran driver."}</p>}
      <Submit>Simpan penerimaan</Submit>
    </div>
  );
}

// ---------------- KOREKSI (upah ditahan) ----------------

export function KoreksiForm({ pickup, tasks }: { pickup: PickupView; tasks: Task[] }) {
  const short = (id: string) => tasks.find((t) => t.id === id)?.short ?? "";
  return (
    <div className="space-y-3">
      <input type="hidden" name="pickupId" value={pickup.id} />
      {pickup.holdNote && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{pickup.holdNote}</p>}
      <p className="text-xs text-slate-500">Hitungan divisi: {pickup.counts.map((c) => `${short(c.taskId)} ${f(c.qty)}`).join(" · ")}. Ubah setoran driver bila driver salah hitung, lalu Simpan koreksi. Bila sudah dicek dan upah tetap dibayar sesuai catatan driver, tekan Lepas tahanan.</p>
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {pickup.lines.map((l) => (
          <label key={l.id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 break-words text-sm">{l.worker} · {short(l.taskId)} <span className="text-xs text-slate-500">(driver {f(l.qty)})</span></span>
            <input name={`l:${l.id}`} defaultValue={l.qty} inputMode="numeric" className="input w-20 text-right tabular-nums" aria-label={`Setoran ${l.worker} ${short(l.taskId)}`} />
          </label>
        ))}
      </div>
      <label className="block"><span className="label">Alasan (wajib)</span><textarea name="reason" rows={2} required minLength={3} className="input" placeholder="Mis. driver salah hitung, sudah dicek di titik" /></label>
      <div className="flex flex-wrap gap-2">
        <Submit name="mode" value="koreksi">Simpan koreksi</Submit>
        <Submit name="mode" value="lepas" className="btn-secondary" confirm="Lepas tahanan: upah dibayar sesuai setoran driver walau hitungan divisi kurang?">Lepas tahanan</Submit>
      </div>
    </div>
  );
}
