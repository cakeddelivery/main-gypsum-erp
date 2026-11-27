"use client";
import { useMemo, useState } from "react";
import { Submit } from "@/components/ActionForm";
import type { CellView, PickupView, ShipmentView } from "@/lib/boronganFlow";
import type { EditOptions } from "@/lib/boronganEdit";

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

/**
 * Grid rapi: judul kolom jenis (Cowok/Cewek/…) SEKALI di atas; tiap pekerja satu baris, isian sama lebar (kolom 60px, angka tengah,
 * tabular-nums), nama di kolom kiri (maks. 2 baris, tooltip nama lengkap). Muat di HP 390px tanpa gulir samping (≤ 4 jenis);
 * lebih banyak jenis menggulir di dalam kartu. Pekerja yang tidak menerima jenis kiriman ini diberi keterangan, bukan baris kosong.
 */
export function WorkerGrid({ tasks, rows, head = "Pekerja" }: { tasks: Task[]; head?: string; rows: { key: string; name: string; sub?: React.ReactNode; cells: (React.ReactNode | null)[] | null }[] }) {
  return (
    <div className="overflow-x-auto" data-grid="pekerja">
      <table className="w-full table-fixed border-collapse text-sm tabular-nums">
        <colgroup><col />{tasks.map((t) => <col key={t.id} style={{ width: 60 }} />)}</colgroup>
        <thead>
          <tr className="text-xs text-slate-500">
            <th className="px-1 pb-1 text-left font-semibold">{head}</th>
            {tasks.map((t) => <th key={t.id} className="px-0.5 pb-1 text-center font-semibold">{t.short}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100">
              <td className="px-1 py-1.5 align-middle">
                <div className="line-clamp-2 break-words text-sm font-semibold leading-tight text-slate-800" title={r.name}>{r.name}</div>
                {r.sub}
              </td>
              {r.cells ? r.cells.map((c, i) => <td key={tasks[i].id} className="px-0.5 py-1 text-center align-middle">{c ?? <span className="text-slate-300">—</span>}</td>) : <td colSpan={tasks.length} className="px-1 py-1.5 text-xs italic text-slate-500">tidak menerima tugas ini</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Satu tabel per pekerja */
export function WorkerCard({ name, sub, tasks, rows, footer }: { name: string; sub?: React.ReactNode; tasks: Task[]; rows: { label: string; muted?: boolean; foot?: boolean; cells: (React.ReactNode | null)[] }[]; footer?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-200 px-3 py-2 text-sm font-bold text-slate-900"><span className="break-words">{name}</span>{sub}</div>
      <div className="overflow-x-auto pr-1.5" data-grid="pekerja">
        <table className="w-full table-fixed text-sm tabular-nums">
          <colgroup><col />{tasks.map((t) => <col key={t.id} style={{ width: 60 }} />)}</colgroup>
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500">
              <th className="sticky left-0 bg-slate-50 px-2 py-1.5 text-left font-semibold">Status</th>
              {tasks.map((t) => <th key={t.id} className="px-0.5 py-1.5 text-center font-semibold">{t.short}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={`border-t border-slate-100 ${r.foot ? "bg-slate-50 font-bold" : ""}`}>
                <td className={`sticky left-0 break-words px-2 py-1.5 text-left font-semibold leading-tight ${r.foot ? "bg-slate-50" : "bg-white"} ${r.muted ? "text-slate-500" : "text-slate-800"}`}>{r.label}</td>
                {r.cells.map((c, i) => <td key={tasks[i].id} className={`px-0.5 py-1 text-center ${r.muted ? "text-slate-500" : ""}`}>{c ?? <span className="text-slate-400">—</span>}</td>)}
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
  tasks: { id: string; short: string; bom: { itemId: string; name: string; unit: string; per: number }[]; /** Hasil diisi saat penerimaan: jumlah per jenis opsional */ resultAtReceipt?: boolean }[];
  points: { id: string; name: string; viaDriver: boolean }[];
  support: { id: string; name: string; unit: string; stock: number }[];
  /** Hasil diisi saat penerimaan: saran jumlah bahan per titik dari kiriman terakhir */
  suggest?: Record<string, { number: string; qty: Record<string, number> }>;
};

/**
 * Kirim bahan. `fixed` = melengkapi kiriman Assembling yang patung keringnya sudah diisi Cetak/Oven: jumlah per jenis
 * tidak bisa diubah, tinggal titik, cara kirim, driver, dan bahan pendukung.
 */
export function KirimForm({ groups, drivers, today, fixed }: { groups: KirimGroupOpt[]; drivers: { id: string; name: string }[]; today: string; fixed?: { shipmentId: string; groupKey: string; qty: Record<string, number> } }) {
  const [key, setKey] = useState(fixed?.groupKey ?? groups[0]?.key ?? "");
  const g = groups.find((x) => x.key === key);
  // Jenis pekerjaan dengan satu titik tujuan (mis. Cat Plastik → Beringin): titik langsung terpilih
  const onlyPoint = (x?: KirimGroupOpt) => (x?.points.length === 1 ? [x.points[0].id] : []);
  const [pts, setPts] = useState<string[]>(() => onlyPoint(groups.find((x) => x.key === (fixed?.groupKey ?? groups[0]?.key))));
  const [qty, setQty] = useState<Record<string, string>>(() => (fixed ? Object.fromEntries(Object.entries(fixed.qty).map(([k, v]) => [k, String(v)])) : {}));
  const chosen = g?.points.filter((p) => pts.includes(p.id)) ?? [];
  // Cara kirim bawaan mengikuti setelan titik: titik "langsung" (tanpa driver, mis. Beringin) → Diantar langsung
  const direct = chosen.length ? chosen.length === 1 && !chosen[0].viaDriver : !!g?.points.length && g.points.every((p) => !p.viaDriver);
  const optional = !fixed && !!g?.tasks.length && g.tasks.every((t) => t.resultAtReceipt);
  const sugKey = chosen.length === 1 ? chosen[0].id : "";
  const sug = optional && sugKey ? g?.suggest?.[sugKey] : undefined;
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
      {fixed && <input type="hidden" name="shipmentId" value={fixed.shipmentId} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {fixed ? <p className="text-sm">Jenis pekerjaan: <b>{g?.name}</b></p> : (
          <label className="block"><span className="label">Jenis pekerjaan</span>
            <select className="input" value={key} onChange={(e) => { setKey(e.target.value); setPts(onlyPoint(groups.find((x) => x.key === e.target.value))); setQty({}); setMode(null); }}>{groups.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select>
          </label>
        )}
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
      {optional ? (
        // Hasil per jenis baru diketahui setelah dikerjakan: tanpa jumlah pcs; jenis pekerjaan tetap dicatat (qty 0)
        <>{g!.tasks.map((t) => <input key={t.id} type="hidden" name={`t:${t.id}`} value="0" />)}</>
      ) : (
      <div className="rounded-xl border border-slate-200 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{fixed ? "Patung kering dari Cetak/Oven (pcs)" : "Jumlah per jenis (pcs)"}</p>
        <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
          {g?.tasks.filter((t) => !fixed || fixed.qty[t.id]).map((t) => fixed ? (
            <div key={t.id} className="rounded-lg bg-slate-50 px-3 py-2"><span className="block text-xs font-medium text-slate-600">{t.short}</span><b className="tabular-nums">{f(fixed.qty[t.id])}</b></div>
          ) : (
            <label key={t.id} className="block"><span className="text-xs font-medium text-slate-600">{t.short}</span>
              <input name={`t:${t.id}`} inputMode="numeric" value={qty[t.id] ?? ""} onChange={(e) => setQty((x) => ({ ...x, [t.id]: e.target.value.replace(/[^\d]/g, "") }))} placeholder="0" className="input text-right tabular-nums" />
            </label>
          ))}
        </div>
        <p className="mt-2 text-right text-sm">Total <b>{f(total)} pcs</b></p>
        {bom.length > 0 && <p className="text-xs text-slate-500">Bahan resep ikut keluar otomatis: {bom.map((b) => `${b.name} ${f(Math.round(b.qty * 1000) / 1000)} ${b.unit}`).join(" · ")}</p>}
      </div>
      )}
      {!!g?.support.length && (
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{optional ? "Bahan yang dikirim" : "Bahan pendukung"}</p>
          {optional && <p className="mb-2 text-xs text-slate-500">Hasil merah/biru/kuning diisi saat <b>penerimaan</b>. {sug ? <>Jumlah terisi saran dari kiriman terakhir <b>{sug.number}</b> — ubah bila perlu.</> : "Isi jumlah bahan yang dikirim."}</p>}
          <div className="space-y-2">
            {g.support.map((i) => (
              <label key={`${i.id}:${sugKey}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-sm">{i.name} <span className="text-xs text-slate-500">· stok {f(i.stock)} {i.unit}</span></span>
                <input name={`s:${i.id}`} inputMode="decimal" placeholder="0" defaultValue={sug?.qty[i.id] != null ? String(sug.qty[i.id]).replace(".", ",") : undefined} className="input w-24 text-right tabular-nums" />
              </label>
            ))}
          </div>
        </div>
      )}
      <label className="block"><span className="label">Catatan</span><input name="note" className="input" /></label>
      <p className="text-xs text-slate-500">{optional ? "Bahan keluar gudang ke titik. Koordinator titik melapor hasil per pekerja; divisi penerima mengisi hasil per jenis saat penerimaan (kroscek)." : mode === "DRIVER" ? "Bahan keluar gudang dan tercatat di mobil driver. Saat driver membagi ke pekerja, bahan tercatat pindah ke titik." : "Bahan keluar gudang langsung ke titik. Pembagian & pengambilan dicatat tim divisi / Supervisor."} Tidak ada lagi konfirmasi terima di titik.</p>
      <Submit>{fixed ? "Lengkapi & kirim" : "Simpan & kirim"}</Submit>
    </div>
  );
}

/** Langkah 1 kiriman Assembling (tim Cetak/Oven): jumlah patung kering per jenis */
export function KeringForm({ tasks, today }: { tasks: { id: string; short: string }[]; today: string }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const total = tasks.reduce((a, t) => a + toInt(qty[t.id]), 0);
  return (
    <div className="space-y-3">
      <label className="block"><span className="label">Tanggal</span><input type="date" name="date" defaultValue={today} max={today} className="input" /></label>
      <div className="rounded-xl border border-slate-200 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Patung kering per jenis (pcs)</p>
        <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
          {tasks.map((t) => (
            <label key={t.id} className="block"><span className="text-xs font-medium text-slate-600">{t.short}</span>
              <input name={`t:${t.id}`} inputMode="numeric" value={qty[t.id] ?? ""} onChange={(e) => setQty((x) => ({ ...x, [t.id]: e.target.value.replace(/[^\d]/g, "") }))} placeholder="0" className="input text-right tabular-nums" />
            </label>
          ))}
        </div>
        <p className="mt-2 text-right text-sm">Total <b>{f(total)} pcs</b></p>
      </div>
      <label className="block"><span className="label">Catatan</span><input name="note" className="input" /></label>
      <p className="text-xs text-slate-500">Setelah disimpan, tim Assembling / Supervisor melengkapi bahan pendukung, titik tujuan, dan driver. Stok baru keluar gudang saat kiriman dilengkapi.</p>
      <Submit>Simpan patung kering</Submit>
    </div>
  );
}

// ---------------- 2. PEMBAGIAN ----------------

/**
 * Ubah SEMUA data kiriman (Owner/Supervisor): tanggal, cara kirim & driver, titik, catatan, jumlah per jenis, dan bahan yang dikirim.
 * Alasan wajib. Stok bahan menyesuaikan otomatis (mutasi selisih). Kiriman selesai/ditutup: hanya catatan.
 */
export function UbahKirimanForm({ view, opts, finished }: { view: ShipmentView; opts: EditOptions; finished: boolean }) {
  const free = !!view.resultAtReceipt;
  const waiting = view.waitingSupport;
  const [mode, setMode] = useState<"DRIVER" | "LANGSUNG">(view.mode);
  const [pts, setPts] = useState<string[]>(view.points.map((p) => p.id));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(view.tasks.map((t) => [t.id, String(t.qty)])));
  const [items, setItems] = useState<Record<string, string>>(() => Object.fromEntries(opts.items.map((i) => [i.id, i.qty ? String(i.qty).replace(".", ",") : ""])));
  const edited = useMemo(() => new Set<string>(), []);
  const dec = (v: string | undefined) => { const n = Number(String(v ?? "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : 0; };
  // Jumlah per jenis berubah → bahan resep ikut menyesuaikan (selama belum diubah manual)
  const changeQty = (taskId: string, v: string) => {
    const next = { ...qty, [taskId]: v.replace(/[^\d]/g, "") };
    setQty(next);
    setItems((cur) => {
      const out = { ...cur };
      for (const i of opts.items) {
        if (edited.has(i.id) || i.per[taskId] == null) continue;
        const base = i.qty;
        const delta = view.tasks.reduce((a, t) => a + (i.per[t.id] ?? 0) * (toInt(next[t.id]) - t.qty), 0);
        const n = Math.max(0, Math.round((base + delta) * 1000) / 1000);
        out[i.id] = n ? String(n).replace(".", ",") : "";
      }
      return out;
    });
  };
  const direct = mode === "LANGSUNG" || free;
  const lockedPoints = !!opts.pointsLocked || !!opts.routeLocked;
  const shown = opts.items.filter((i) => i.qty > 0 || (items[i.id] ?? "") !== "" || true);
  const underMin = view.tasks.some((t) => toInt(qty[t.id]) < (opts.minQty[t.id] ?? 0));
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} />
      {finished && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Kiriman ini sudah {view.closed ? "ditutup" : "selesai"}: hanya <b>catatan</b> yang bisa diubah.</p>}
      {!finished && (
        <>
          <label className="block"><span className="label">Tanggal</span><input type="date" name="date" defaultValue={view.date} className="input" /></label>
          {!waiting && (
            <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Titik, cara kirim & driver</legend>
              {opts.routeLocked ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{opts.routeLocked}.</p> : (
                <>
                  <input type="hidden" name="mode" value={mode} />
                  <div className="grid grid-cols-2 gap-2 keep-cols">
                    {(["DRIVER", "LANGSUNG"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => { setMode(m); if (m === "LANGSUNG") setPts((x) => x.slice(0, 1)); }} aria-pressed={mode === m} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${mode === m ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-700"}`}>{m === "DRIVER" ? "Lewat driver" : "Diantar langsung"}</button>
                    ))}
                  </div>
                  {mode === "DRIVER" && opts.drivers.length > 0 && (
                    <label className="block"><span className="label">Driver</span><select name="driverId" className="input" defaultValue={view.driverId ?? opts.drivers[0].id}>{opts.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
                  )}
                  {opts.pointsLocked ? <p className="text-xs text-slate-500">{opts.pointsLocked}. Titik: <b>{view.points.map((p) => p.name).join(", ")}</b></p> : (
                    <>
                      <input type="hidden" name="pointSent" value="1" />
                      <div className="flex flex-wrap gap-2">
                        {opts.points.map((p) => (
                          <label key={p.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${pts.includes(p.id) ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-300"}`}>
                            <input type="checkbox" name="pointId" value={p.id} checked={pts.includes(p.id)} onChange={(e) => setPts((x) => (e.target.checked ? (direct ? [p.id] : [...x, p.id]) : x.filter((y) => y !== p.id)))} className="h-4 w-4" />
                            {p.name}{!p.viaDriver && <span className="text-xs text-slate-500">(langsung)</span>}
                          </label>
                        ))}
                      </div>
                      {direct && pts.length > 1 && <p className="text-xs text-rose-700">Diantar langsung hanya untuk satu titik.</p>}
                    </>
                  )}
                  <p className="text-xs text-slate-500">Mengganti titik / cara kirim memindahkan bahan: kembali dari lokasi lama lalu keluar ke lokasi baru (mutasi selisih).</p>
                </>
              )}
            </fieldset>
          )}
          {!free && (
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Jumlah per jenis (pcs)</p>
              <table className="w-full table-fixed text-sm tabular-nums">
                <colgroup><col /><col style={{ width: 64 }} /><col style={{ width: 72 }} /><col style={{ width: 72 }} /></colgroup>
                <thead><tr className="text-xs text-slate-500"><th className="text-left font-semibold">Jenis</th><th className="text-right font-semibold">Sekarang</th><th className="text-center font-semibold">Baru</th><th className="text-right font-semibold">Min.</th></tr></thead>
                <tbody>
                  {view.tasks.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="py-1 font-semibold text-slate-800">{t.short}</td>
                      <td className="py-1 text-right text-slate-500">{f(t.qty)}</td>
                      <td className="py-1 text-center"><NumIn name={`t:${t.id}`} label={`Jumlah baru ${t.short}`} value={qty[t.id] ?? ""} onChange={(v) => changeQty(t.id, v)} /></td>
                      <td className={`py-1 text-right ${toInt(qty[t.id]) < (opts.minQty[t.id] ?? 0) ? "font-bold text-rose-700" : "text-slate-500"}`}>{f(opts.minQty[t.id] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {underMin && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Ada jenis yang lebih kecil dari yang sudah dibagi.</p>}
            </div>
          )}
          {!waiting && (
            <div className="rounded-xl border border-slate-200 p-3">
              <input type="hidden" name="linesSent" value="1" />
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Bahan yang dikirim</p>
              <p className="mb-2 text-xs text-slate-500">Ubah jumlah, kosongkan untuk menghapus, atau isi bahan yang belum ada untuk menambah. Bahan resep ikut menyesuaikan bila jumlah per jenis diubah (boleh ditimpa manual).</p>
              <div className="space-y-2">
                {shown.map((i) => (
                  <label key={i.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words text-sm">{i.name} <span className="text-xs text-slate-500">· {i.qty ? `sekarang ${f(i.qty)} · ` : ""}stok {f(i.stock)} {i.unit}</span></span>
                    <input name={`s:${i.id}`} inputMode="decimal" value={items[i.id] ?? ""} onChange={(e) => { edited.add(i.id); setItems((x) => ({ ...x, [i.id]: e.target.value })); }} placeholder="0" className="input w-24 text-right tabular-nums" />
                  </label>
                ))}
              </div>
              {opts.items.length === 0 && <p className="text-sm text-slate-500">Tidak ada bahan yang bisa dipilih.</p>}
            </div>
          )}
        </>
      )}
      <label className="block"><span className="label">Catatan</span><input name="note" defaultValue={view.note ?? ""} className="input" /></label>
      <label className="block"><span className="label">Alasan perubahan (wajib)</span><input name="reason" className="input" required minLength={3} placeholder="mis. Beringin diantar langsung, bukan lewat driver" /></label>
      <p className="text-xs text-slate-500">Tercatat di riwayat dengan nilai lama → baru. Stok dikoreksi dengan mutasi selisih; stok di lokasi asal harus cukup.</p>
      <Submit confirm="Simpan perubahan kiriman? Stok bahan disesuaikan dan tercatat di riwayat.">Simpan perubahan</Submit>
    </div>
  );
}

/** Ubah jumlah yang dikirim per jenis (Owner/Supervisor): batas minimal = yang sudah dibagi ke pekerja */
export function UbahJumlahForm({ view }: { view: ShipmentView }) {
  const min = (taskId: string) => view.cells.filter((c) => c.taskId === taskId).reduce((a, c) => a + c.dibagi, 0);
  const [val, setVal] = useState<Record<string, string>>(() => Object.fromEntries(view.tasks.map((t) => [t.id, String(t.qty)])));
  const bad = view.tasks.some((t) => toInt(val[t.id]) < min(t.id));
  const changed = view.tasks.some((t) => toInt(val[t.id]) !== t.qty);
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} />
      <p className="text-xs text-slate-500">Ubah jumlah patung yang <b>dikirim</b> per jenis. Tidak boleh kurang dari yang sudah dibagi ke pekerja (batas minimal). Stok bahan menyesuaikan otomatis (selisih saja): dikurangi → kembali ke gudang, ditambah → keluar lagi dari gudang. Tercatat di riwayat dengan nilai lama → baru.</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 p-2">
        <table className="w-full table-fixed text-sm tabular-nums">
          <colgroup><col /><col style={{ width: 64 }} /><col style={{ width: 72 }} /><col style={{ width: 72 }} /></colgroup>
          <thead><tr className="text-xs text-slate-500"><th className="text-left font-semibold">Jenis</th><th className="text-right font-semibold">Sekarang</th><th className="text-center font-semibold">Baru</th><th className="text-right font-semibold">Min.</th></tr></thead>
          <tbody>
            {view.tasks.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="py-1 font-semibold text-slate-800">{t.short}</td>
                <td className="py-1 text-right text-slate-500">{f(t.qty)}</td>
                <td className="py-1 text-center"><NumIn name={`t:${t.id}`} label={`Jumlah baru ${t.short}`} value={val[t.id] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [t.id]: v }))} /></td>
                <td className={`py-1 text-right ${toInt(val[t.id]) < min(t.id) ? "font-bold text-rose-700" : "text-slate-500"}`}>{f(min(t.id))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bad && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Ada jenis yang lebih kecil dari yang sudah dibagi.</p>}
      <label className="block"><span className="label">Alasan (wajib)</span><input name="reason" className="input" required minLength={3} placeholder="mis. patung kering yang dikirim ternyata 600, bukan 700" /></label>
      <Submit confirm={changed ? "Ubah jumlah kiriman? Stok bahan disesuaikan dan tercatat di riwayat." : undefined}>Simpan perubahan jumlah</Submit>
    </div>
  );
}

export function BagiForm({ view, workers, canEditQty = false }: { view: ShipmentView; workers: { id: string; name: string; pointId: string; taskIds: string[] }[]; /** Owner/Supervisor: petunjuk ubah jumlah kiriman bila sisa ≠ 0 */ canEditQty?: boolean }) {
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
              <WorkerGrid tasks={view.tasks} rows={list.map((w) => {
                // Pekerja yang jenis pekerjaannya diatur (tab Orang) hanya menerima jenis itu; tanpa satu pun yang cocok → keterangan
                const ok = (t: Task) => !w.taskIds.length || w.taskIds.includes(t.id);
                if (!view.tasks.some(ok)) return { key: w.id, name: w.name, cells: null };
                return { key: w.id, name: w.name, cells: view.tasks.map((t) => {
                  if (!ok(t)) return null;
                  const k = `a:${p.id}:${w.id}:${t.id}`;
                  return <NumIn name={k} label={`${w.name} ${t.short}`} value={val[k] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [k]: v }))} />;
                }) };
              })} />
            )}
          </div>
        );
      })}
      <div className="overflow-hidden rounded-xl bg-slate-50 p-3" data-grid="ringkasan">
        <table className="w-full table-fixed text-sm tabular-nums">
          <colgroup><col /><col style={{ width: 64 }} /><col style={{ width: 64 }} /><col style={{ width: 64 }} /></colgroup>
          <thead><tr className="text-xs text-slate-500"><th className="text-left font-semibold">Jenis</th><th className="text-right font-semibold">Dibagi</th><th className="text-right font-semibold">Kiriman</th><th className="text-right font-semibold">Sisa</th></tr></thead>
          <tbody>
            {view.tasks.map((t) => {
              const d = sum(t.id);
              return (
                <tr key={t.id} className="border-t border-slate-200">
                  <td className="py-0.5">{t.short}</td>
                  <td className="py-0.5 text-right font-bold">{f(d)}</td>
                  <td className="py-0.5 text-right">{f(t.qty)}</td>
                  <td className={`py-0.5 text-right font-bold ${d > t.qty ? "text-rose-700" : d < t.qty ? "text-amber-700" : "text-emerald-700"}`}>{f(t.qty - d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {over && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Pembagian melebihi jumlah kiriman.</p>}
      {left !== 0 && canEditQty && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Sisa tidak sama dengan nol karena jumlah kirimannya keliru? Simpan/tutup form ini, lalu pilih <b>Ubah jumlah kiriman</b> di kartu kiriman, atau buka detail kiriman › <b>Ubah kiriman</b> (Owner/Supervisor).</p>}
      <Submit confirm={left > 0 ? `Masih ada ${f(left)} pcs yang belum dibagi. Tetap simpan?` : undefined}>Simpan pembagian</Submit>
    </div>
  );
}

// ---------------- 3. LAPOR HASIL ----------------

export function LaporForm({ view, pointId, workers = [] }: { view: ShipmentView; pointId: string; /** Hasil diisi saat penerimaan: semua pekerja aktif titik (tanpa pembagian) */ workers?: { id: string; name: string; pointId: string | null; taskIds: string[] }[] }) {
  if (view.resultAtReceipt) return <LaporBebasForm view={view} pointId={pointId} workers={workers.filter((w) => w.pointId === pointId)} />;
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

/** Lapor hasil tanpa pembagian (tugas "hasil diisi saat penerimaan", mis. Cat Plastik): setoran & reject per pekerja per jenis */
function LaporBebasForm({ view, pointId, workers }: { view: ShipmentView; pointId: string; workers: { id: string; name: string; taskIds: string[] }[] }) {
  const [val, setVal] = useState<Record<string, string>>(() => Object.fromEntries(view.cells.filter((c) => c.pointId === pointId && c.reported).flatMap((c) => [[`g:${c.workerId}:${c.taskId}`, String(c.good)], [`r:${c.workerId}:${c.taskId}`, String(c.reject)]])));
  const total = (t: Task) => Object.entries(val).filter(([k]) => k.startsWith("g:") && k.endsWith(`:${t.id}`)).reduce((a, [, v]) => a + toInt(v), 0);
  const anyReject = Object.entries(val).some(([k, v]) => k.startsWith("r:") && toInt(v) > 0);
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} /><input type="hidden" name="pointId" value={pointId} />
      <p className="text-xs text-slate-500">Isi setoran <b>bagus</b> & reject tiap pekerja per jenis. Angka ini menjadi kroscek terhadap hitungan divisi penerima; upah mengikuti jumlah yang diterima divisi, dibagi menurut porsi laporan ini.</p>
      {!workers.length && <p className="text-sm text-slate-500">Belum ada pekerja aktif di titik ini.</p>}
      {workers.map((w) => {
        const ok = (t: Task) => !w.taskIds.length || w.taskIds.includes(t.id);
        if (!view.tasks.some(ok)) return <div key={w.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"><b className="break-words" title={w.name}>{w.name}</b> <span className="text-xs italic text-slate-500">tidak menerima tugas ini</span></div>;
        const input = (p: "g" | "r", t: Task) => {
          if (!ok(t)) return null;
          const k = `${p}:${w.id}:${t.id}`;
          return <NumIn name={k} label={`${p === "g" ? "Setoran" : "Reject"} ${w.name} ${t.short}`} value={val[k] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [k]: v }))} />;
        };
        return <WorkerCard key={w.id} name={w.name} tasks={view.tasks} rows={[{ label: "Setoran", cells: view.tasks.map((t) => input("g", t)) }, { label: "Reject", cells: view.tasks.map((t) => input("r", t)) }]} />;
      })}
      <div className="rounded-xl bg-slate-50 p-3 text-sm">{view.tasks.map((t) => <div key={t.id} className="flex justify-between"><span>{t.short}</span><b className="tabular-nums">{f(total(t))} pcs</b></div>)}</div>
      <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold">
        <input type="checkbox" name="checked" className="h-5 w-5" /> Reject sudah dicek koordinator
      </label>
      {anyReject && <p className="text-xs text-slate-500">Reject tidak dibayar dan tidak memotong upah.</p>}
      <p className="text-xs text-slate-500">Angka diisi total sejak kiriman ini. Boleh lapor lagi sebelum hasil diterima divisi.</p>
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
  const [rej, setRej] = useState<Record<string, string>>({});
  const filled = used.every((t) => (val[t.id] ?? "") !== "");
  const short = filled && used.some((t) => toInt(val[t.id]) + toInt(rej[t.id]) < driver(t.id));
  return (
    <div className="space-y-3">
      <input type="hidden" name="pickupId" value={pickup.id} />
      <p className="text-xs text-slate-500">Hitung <b>total</b> setoran per jenis. Isi <b>reject saat diterima</b> bila ada patung rusak: hanya dicatat (upah & klaim tidak berubah), barang rusak tidak masuk gudang. Rincian per pekerja diambil dari catatan driver.</p>
      <WorkerCard name="Total pengambilan ini" tasks={used} rows={[
        { label: "Setoran driver", muted: true, cells: used.map((t) => f(driver(t.id))) },
        { label: "Dihitung (bagus)", cells: used.map((t) => <NumIn key={t.id} name={`c:${t.id}`} label={`Dihitung ${t.short}`} value={val[t.id] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [t.id]: v }))} />) },
        { label: "Reject saat diterima", cells: used.map((t) => <NumIn key={t.id} name={`r:${t.id}`} label={`Reject penerimaan ${t.short}`} value={rej[t.id] ?? ""} onChange={(v) => setRej((x) => ({ ...x, [t.id]: v }))} />) },
        { label: "Selisih", foot: true, cells: used.map((t) => ((val[t.id] ?? "") === "" ? "" : <Diff n={toInt(val[t.id]) + toInt(rej[t.id]) - driver(t.id)} done />)) },
      ]} />
      {filled && <p className={`rounded-lg px-3 py-2 text-sm ${short ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{short ? "Hitungan kurang dari setoran driver: upah pengambilan ini ditahan, driver & Supervisor diberi notifikasi." : "Cocok: barang masuk gudang, upah per pekerja mengikuti setoran driver."}</p>}
      <Submit>Simpan penerimaan</Submit>
    </div>
  );
}

/** Penerimaan hasil per jenis (tugas "hasil diisi saat penerimaan"): divisi menghitung total tiap jenis dari titik ini */
export function TerimaJenisForm({ view, pointId, edit = false }: { view: ShipmentView; pointId: string; /** Sudah pernah disimpan (terkunci): hanya Owner/Supervisor, alasan wajib */ edit?: boolean }) {
  const [val, setVal] = useState<Record<string, string>>(() => (edit ? Object.fromEntries((view.crosscheck ?? []).filter((c) => c.pointId === pointId && c.received != null).map((c) => [c.taskId, String(c.received)])) : {}));
  const [rej, setRej] = useState<Record<string, string>>(() => (edit ? Object.fromEntries(view.pickups.filter((p) => p.status !== "DIBATALKAN").flatMap((p) => p.counts).map((c) => [c.taskId, String(c.reject ?? 0)])) : {}));
  const total = view.tasks.reduce((a, t) => a + toInt(val[t.id]), 0);
  return (
    <div className="space-y-3">
      <input type="hidden" name="shipmentId" value={view.id} /><input type="hidden" name="pointId" value={pointId} />
      <p className="text-xs text-slate-500">Hitung hasil yang <b>diterima</b> per jenis (0 bila tidak ada). Boleh diisi sebelum koordinator melapor; upah dihitung setelah keduanya ada. Laporan koordinator dipakai sebagai kroscek; selisih dikirim ke koordinator, Supervisor & Owner. Upah pekerja mengikuti yang diterima.</p>
      {edit && <label className="block"><span className="label">Alasan perubahan (wajib, penerimaan sudah terkunci)</span><input name="reason" className="input" required minLength={3} /></label>}
      <WorkerCard name="Diterima divisi" tasks={view.tasks} rows={[{ label: "Diterima (bagus)", cells: view.tasks.map((t) => <NumIn key={t.id} name={`c:${t.id}`} label={`Diterima ${t.short}`} value={val[t.id] ?? ""} onChange={(v) => setVal((x) => ({ ...x, [t.id]: v }))} />) }, { label: "Reject saat diterima", cells: view.tasks.map((t) => <NumIn key={t.id} name={`r:${t.id}`} label={`Reject penerimaan ${t.short}`} value={rej[t.id] ?? ""} onChange={(v) => setRej((x) => ({ ...x, [t.id]: v }))} />) }]} />
      <p className="text-right text-sm">Total diterima <b>{f(total)} pcs</b></p>
      <Submit confirm={edit ? "Ubah penerimaan? Kroscek & upah dihitung ulang; perubahan tercatat di audit." : "Simpan penerimaan? Setelah disimpan terkunci (ubah hanya Owner/Supervisor dengan alasan)."}>{edit ? "Simpan perubahan" : "Simpan penerimaan"}</Submit>
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
