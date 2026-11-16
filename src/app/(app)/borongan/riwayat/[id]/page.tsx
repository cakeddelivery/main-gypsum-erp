import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { dateOnly, fmtDay } from "@/lib/time";
import { STATE_LABEL, shipmentView } from "@/lib/boronganFlow";
import { isAssemblingTask } from "@/lib/boronganClaim";
import { Badge, PageHeader } from "@/components/ui";
import { WorkerCard } from "../../KirimanForms";
import { canSeeHistory } from "../access";

export const metadata = { title: "Detail kiriman borongan" };
const f = (n: number) => n.toLocaleString("id-ID");
const PICKUP = { DIBAWA: ["menunggu dihitung", "amber"], DITERIMA: ["cocok / diterima", "green"], KURANG: ["kurang, upah ditahan", "red"], DIBATALKAN: ["dibatalkan", "gray"] } as const;

/** Detail satu kiriman: ringkasan angka, bahan dikirim, tabel per pekerja, setiap pengambilan, info untuk tim Oven */
export default async function KirimanDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("borongan.view", "borongan.point", "borongan.manage");
  if (!(await canSeeHistory(user))) notFound();
  const s = await shipmentView((await params).id);
  if (!s) notFound();
  const workers = [...new Map(s.cells.map((c) => [c.workerId, { id: c.workerId, name: c.worker, pointId: c.pointId }])).values()];
  const pname = (id: string) => s.points.find((p) => p.id === id)?.name ?? "";
  const active = s.pickups.filter((p) => p.status !== "DIBATALKAN");
  const short = (id: string) => s.tasks.find((t) => t.id === id)?.short ?? "";
  const gap = s.totals.gap;
  const patung = s.tasks.some((t) => isAssemblingTask(t.name));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={s.number} subtitle={`${fmtDay(dateOnly(s.date))} · ${s.points.map((p) => p.name).join(", ")} · ${s.group} · ${s.mode === "DRIVER" ? `lewat driver${s.driver ? ` (${s.driver})` : ""}` : "diantar langsung"}`} />
      <div className="flex flex-wrap items-center gap-2">
        {s.cancelled ? <Badge tone="gray">Dibatalkan</Badge> : s.waitingSupport ? <Badge tone="amber">Menunggu bahan pendukung</Badge> : <Badge tone={s.state === "SELESAI" ? "green" : "amber"}>{STATE_LABEL[s.state]}</Badge>}
        <span className="text-sm text-slate-500">dicatat {s.createdBy}</span>
        <Link href="/borongan/riwayat" className="ml-auto text-sm font-semibold text-brand-700 underline">← Riwayat</Link>
      </div>

      <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
        {[["Dikirim", f(s.totals.sent), false], ["Setoran diterima", f(s.totals.received), false], ["Reject", f(s.totals.reject), false], [gap == null ? "Masih di pekerja" : "Selisih", gap == null ? f(s.totals.atWorkers) : f(gap), !!gap]].map(([k, v, bad]) => (
          <div key={String(k)} className={`rounded-xl p-3 ${bad ? "bg-rose-50 text-rose-700" : "bg-slate-50"}`}>
            <div className="text-xs font-semibold text-slate-500">{k}</div>
            <div className="text-2xl font-extrabold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Kiriman bahan</h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
          {s.tasks.map((t) => <div key={t.id} className="flex justify-between gap-2 border-b border-slate-100 px-3 py-1.5"><span>{t.short}</span><b className="tabular-nums">{f(t.qty)} pcs</b></div>)}
          {s.lines.map((l) => <div key={l.itemId} className="flex justify-between gap-2 border-b border-slate-100 px-3 py-1.5 text-slate-600"><span className="min-w-0 break-words">{l.name}{l.support ? " (pendukung)" : ""}</span><span className="whitespace-nowrap tabular-nums">{f(l.qty)} {l.unit}</span></div>)}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Pembagian &amp; setoran per pekerja</h2>
        {!workers.length && <p className="text-sm text-slate-500">Belum dibagi ke pekerja.</p>}
        {workers.map((w) => {
          const cell = (taskId: string) => s.cells.find((c) => c.workerId === w.id && c.taskId === taskId);
          const anyDone = s.cells.some((c) => c.workerId === w.id && c.done);
          return (
            <WorkerCard key={w.id} name={w.name} sub={<span className="text-xs font-medium text-slate-500">· {pname(w.pointId)}</span>} tasks={s.tasks} rows={[
              { label: "Dibagi", muted: true, cells: s.tasks.map((t) => (cell(t.id) ? f(cell(t.id)!.dibagi) : null)) },
              { label: "Setoran", cells: s.tasks.map((t) => (cell(t.id) ? f(cell(t.id)!.diambil) : null)) },
              { label: "Reject", cells: s.tasks.map((t) => { const c = cell(t.id); return c ? (c.reported ? f(c.reject) : <span className="text-xs text-slate-400">belum</span>) : null; }) },
              { label: anyDone ? "Sisa / selisih" : "Sisa", foot: true, cells: s.tasks.map((t) => { const c = cell(t.id); if (!c) return null; const n = c.dibagi - c.diambil - c.reject; return c.done ? (n ? <span className="text-rose-700">selisih {f(n)}</span> : "0") : <span>{f(n)} <span className="text-xs font-normal text-slate-500">sisa</span></span>; }) },
            ]} />
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Pengambilan ({active.length}×)</h2>
        {!active.length && <p className="text-sm text-slate-500">Belum ada pengambilan. Semua masih di pekerja.</p>}
        {s.pickups.map((p, i) => {
          const [label, tone] = PICKUP[p.status];
          return (
            <div key={p.id} className="card space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="break-all rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs font-semibold text-brand-700">{p.number}</span><span className="text-slate-600">ke-{i + 1} · {fmtDay(dateOnly(p.date))}{p.driver ? ` · ${p.driver}` : ""}</span><span className="ml-auto"><Badge tone={tone}>{label}</Badge></span></div>
              {p.counts.length > 0 && <div className="text-xs text-slate-500">Dihitung divisi: {p.counts.map((c) => `${short(c.taskId)} ${f(c.qty)}`).join(" · ")}</div>}
              {p.holdNote && <div className="text-xs text-rose-700">{p.holdNote}</div>}
              <ul className="divide-y divide-slate-100">
                {p.lines.map((l) => <li key={l.id} className="flex justify-between gap-2 py-1"><span className="min-w-0 break-words">{l.worker} · {short(l.taskId)}{!l.done && <span className="ml-1 rounded-full bg-amber-50 px-1.5 text-xs font-semibold text-amber-700">sebagian</span>}</span><span className="whitespace-nowrap text-slate-500">setoran <b className="text-slate-900">{f(l.qty)}</b></span></li>)}
              </ul>
            </div>
          );
        })}
      </section>

      {!!gap && gap > 0 && patung && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Info untuk tim Oven: selisih {f(gap)} pcs pada kiriman ini. Ada kemungkinan salah hitung saat patung kering dimasukkan ke keranjang. Selisih ini hanya informasi dan tidak memotong upah siapa pun.</p>
      )}
    </div>
  );
}
