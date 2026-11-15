"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Paged } from "@/components/Paged";
import { toast } from "@/components/Toaster";
import { allIn, cellKey, diffCells, quickFill, type Cell, type SchedRow } from "@/lib/scheduleEdit";
import type { ActionResult } from "@/lib/action";

export type SchedGroupView = { key: string; name: string; shiftDiv: boolean; rows: { id: string; name: string }[] };
type Day = { date: string; label: string };

const VIEW: Record<Cell, React.ReactNode> = {
  "": <span className="text-slate-400" aria-label="Libur">—</span>,
  IN: <span className="inline-grid h-6 min-w-[1.75rem] place-items-center rounded-md bg-emerald-50 px-1.5 text-xs font-bold text-emerald-700" aria-label="Masuk">✓</span>,
  S1: <span className="inline-grid h-6 min-w-[1.75rem] place-items-center rounded-md bg-brand-50 px-1.5 text-xs font-bold text-brand-700">S1</span>,
  S2: <span className="inline-grid h-6 min-w-[1.75rem] place-items-center rounded-md bg-amber-50 px-1.5 text-xs font-bold text-amber-700">S2</span>,
};

/** Saklar 3 posisi untuk divisi 2 shift: S1 · — · S2 */
function Seg({ value, label, onChange }: { value: Cell; label: string; onChange: (v: Cell) => void }) {
  const opts: [Cell, string, string][] = [
    ["S1", "S1", "bg-brand-50 text-brand-700"],
    ["", "—", "bg-white text-slate-800"],
    ["S2", "S2", "bg-amber-50 text-amber-700"],
  ];
  return (
    <span role="group" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-slate-100">
      {opts.map(([v, t, on], i) => (
        <button key={t} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={`h-8 min-w-[2rem] px-1.5 text-xs font-bold ${i ? "border-l border-slate-300" : ""} ${value === v ? on : "text-slate-500"}`}>
          {t}
        </button>
      ))}
    </span>
  );
}

/**
 * Tabel jadwal mingguan. "Atur jadwal" mengubah tabel ke mode atur di tempat: sel jadi kotak centang (masuk/libur),
 * divisi 2 shift memakai saklar S1 · — · S2. Tombol cepat per tanggal, bar simpan menempel di bawah.
 */
export function ScheduleTable({ days, groups, saved, canEdit, save }: { days: Day[]; groups: SchedGroupView[]; saved: Record<string, Cell>; canEdit: boolean; save: (p: ActionResult | null, fd: FormData) => Promise<ActionResult> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, Cell>>(saved);
  const [pending, start] = useTransition();
  const router = useRouter();
  const rows: SchedRow[] = useMemo(() => groups.flatMap((g) => g.rows.map((r) => ({ employeeId: r.id, shiftDiv: g.shiftDiv }))), [groups]);
  const changes = useMemo(() => diffCells(saved, draft), [saved, draft]);
  const dirty = editing && changes.length > 0;

  // Data baru dari server (setelah simpan / ganti minggu) → draf ikut segar bila tidak sedang mengatur
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);
  // Peringatan bila meninggalkan halaman dengan perubahan belum disimpan
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[href]");
      if (a && !a.closest("[data-sched]") && !window.confirm("Ada perubahan jadwal yang belum disimpan. Tinggalkan halaman?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  const set = (id: string, date: string, v: Cell) => setDraft((d) => ({ ...d, [cellKey(id, date)]: v }));
  const cancel = () => {
    setDraft(saved);
    setEditing(false);
  };
  const submit = () =>
    start(async () => {
      const fd = new FormData();
      fd.set("changes", JSON.stringify(changes));
      const r = await save(null, fd);
      if (!r.ok) return void toast(r.error ?? "Gagal menyimpan", false);
      toast(r.message ?? "Jadwal tersimpan");
      setEditing(false);
      router.refresh();
    });

  return (
    <div data-sched className={`space-y-3 ${editing ? "pb-24 lg:pb-4" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${editing ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>{editing ? "Mode atur" : "Lihat"}</span>
        <span className="flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="flex items-center gap-1">{VIEW.IN} Masuk</span>
          <span className="flex items-center gap-1">{VIEW.S1} Shift 1</span>
          <span className="flex items-center gap-1">{VIEW.S2} Shift 2</span>
          <span className="flex items-center gap-1">{VIEW[""]} Libur / belum diatur</span>
        </span>
        {canEdit && !editing && <button type="button" className="btn-primary ml-auto" onClick={() => { setDraft(saved); setEditing(true); }}>Atur jadwal</button>}
      </div>
      <div className="table-wrap">
        <Paged size={15}>
          <table className="tbl tbl-grid">
            <thead>
              <tr>
                <th className="sticky left-0 z-[2] min-w-[8.5rem] bg-slate-50 shadow-[1px_0_0_rgb(var(--bd-slate-200))]">Karyawan</th>
                {days.map((d) => (
                  <th key={d.date} className="text-center align-top">
                    <div>{d.label}</div>
                    {editing && (
                      <button type="button" className="mt-1 whitespace-nowrap rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold normal-case text-brand-700" onClick={() => setDraft((x) => quickFill(x, d.date, rows))}>
                        {allIn(draft, d.date, rows) ? "Kosongkan" : "Semua masuk"}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={`g-${g.key}`} data-pg-group className="bg-slate-50 hover:bg-slate-50">
                  <td colSpan={days.length + 1} className="text-xs font-bold uppercase tracking-wide text-slate-600">
                    {/* Teks judul ikut menempel di kiri saat tabel digeser */}
                    <span className="sticky left-3">
                      {g.name} <span className="font-medium normal-case text-slate-500">· {g.rows.length} orang{g.shiftDiv && editing ? " · saklar shift" : ""}</span>
                    </span>
                  </td>
                </tr>,
                ...g.rows.map((e) => (
                  <tr key={e.id}>
                    <td className="sticky left-0 z-[1] min-w-[8.5rem] max-w-[10.5rem] !whitespace-normal break-words bg-white font-medium leading-snug shadow-[1px_0_0_rgb(var(--bd-slate-200))]">{e.name}</td>
                    {days.map((d) => {
                      const k = cellKey(e.id, d.date);
                      const v = (editing ? draft[k] : saved[k]) ?? "";
                      const label = `${e.name}, ${d.label}`;
                      return (
                        <td key={d.date} className="text-center">
                          {!editing ? (
                            VIEW[v]
                          ) : g.shiftDiv ? (
                            <Seg value={v} label={label} onChange={(nv) => set(e.id, d.date, nv)} />
                          ) : (
                            <input type="checkbox" aria-label={label} checked={v !== ""} onChange={(ev) => set(e.id, d.date, ev.target.checked ? "IN" : "")} className="h-7 w-7 accent-emerald-600" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </Paged>
      </div>
      {editing && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-lg lg:bottom-3">
          <span className="text-sm text-slate-600">{changes.length ? `${changes.length} perubahan belum disimpan` : "Belum ada perubahan"}</span>
          <span className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={cancel} disabled={pending}>Batal</button>
            <button type="button" className="btn-primary" onClick={submit} disabled={pending || !changes.length}>{pending ? "Menyimpan…" : "Simpan"}</button>
          </span>
        </div>
      )}
    </div>
  );
}
