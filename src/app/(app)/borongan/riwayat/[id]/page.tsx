import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { dateOnly, fmtDay } from "@/lib/time";
import { STATE_LABEL, canCancelShipment, canSeeShipment, forCoordinator, fullAccess, isCoordinatorScope, shipmentView } from "@/lib/boronganFlow";
import { boronganScope } from "@/lib/borongan";
import { prisma } from "@/lib/db";
import { isAssemblingTask } from "@/lib/boronganClaim";
import { shipmentEditOptions } from "@/lib/boronganEdit";
import { shipmentHistory } from "@/lib/boronganHistory";
import { Badge, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { UbahKirimanForm, WorkerCard } from "../../KirimanForms";
import { batalKiriman, ubahKiriman } from "../../kirimanActions";
import { canSeeHistory } from "../access";

export const metadata = { title: "Detail kiriman borongan" };
const f = (n: number) => n.toLocaleString("id-ID");
const PICKUP = { DIBAWA: ["menunggu dihitung", "amber"], DITERIMA: ["cocok / diterima", "green"], KURANG: ["kurang, upah ditahan", "red"], DIBATALKAN: ["dibatalkan", "gray"] } as const;

/** Detail satu kiriman: ringkasan angka, bahan dikirim, tabel per pekerja, setiap pengambilan, info untuk tim Oven */
export default async function KirimanDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("borongan.view", "borongan.point", "borongan.manage", "borongan.driver");
  // Semua pengguna borongan, sesuai hak lihat masing-masing (aturan sama dengan daftar Kiriman): Owner/Supervisor semua; tim divisi
  // kiriman tugasnya; driver kiriman lewat driver; koordinator hanya bagian titiknya (disaring di server)
  const scope = await boronganScope(prisma, user);
  const raw = await shipmentView((await params).id);
  if (!raw) notFound();
  const full = await canSeeHistory(user);
  if (!full && !canSeeShipment(scope, raw)) notFound();
  const coordinatorView = !full && isCoordinatorScope(scope);
  const s = coordinatorView ? forCoordinator(raw, scope.pointIds) : raw;
  if (!s) notFound();
  const admin = fullAccess(scope) && !coordinatorView;
  const [history, creator, opts] = await Promise.all([
    shipmentHistory(s.id, s.pickups.map((p) => p.id), !coordinatorView && !scope.driver),
    prisma.boronganShipment.findUnique({ where: { id: s.id }, select: { createdById: true, _count: { select: { allots: true } } } }),
    admin && !s.cancelled ? shipmentEditOptions(s) : Promise.resolve(null),
  ]);
  const finished = s.state === "SELESAI" || !!s.closed;
  const canCancel = !!creator && !s.cancelled && canCancelShipment(scope, { waitingSupport: s.waitingSupport, createdById: creator.createdById, _count: creator._count }, user.id) && !s.pickups.some((p) => p.status !== "DIBATALKAN");
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
        <Link href={full ? "/borongan/riwayat" : "/borongan?tab=kiriman"} className="ml-auto text-sm font-semibold text-brand-700 underline">← {full ? "Riwayat" : "Kiriman"}</Link>
      </div>
      {(opts || canCancel) && (
        <div className="flex flex-wrap gap-2">
          {opts && (
            <Modal trigger="Ubah kiriman" triggerClass="btn-primary btn-sm" title="Ubah kiriman" subtitle={`${s.number} · ${s.group}`} wide>
              <ModalForm action={ubahKiriman} className="space-y-3"><UbahKirimanForm view={s} opts={opts} finished={finished} /></ModalForm>
            </Modal>
          )}
          {canCancel && (
            <ActionForm action={batalKiriman} confirm={`Batalkan kiriman ${s.number}? Bahan kembali ke gudang.`}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm text-rose-600">Batalkan kiriman</button></ActionForm>
          )}
        </div>
      )}
      {s.closed && <p className="rounded-xl bg-slate-50 px-4 py-2 text-sm text-slate-600">{s.closed}</p>}
      {s.note && <p className="break-words rounded-xl bg-slate-50 px-4 py-2 text-sm text-slate-700"><b>Catatan:</b> {s.note}</p>}

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

      {s.resultAtReceipt && s.crosscheck && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Kroscek hasil per jenis</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full table-fixed text-sm tabular-nums">
              <colgroup><col />{s.tasks.map((t) => <col key={t.id} style={{ width: 64 }} />)}</colgroup>
              <thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-2 py-1 text-left font-semibold">Hasil</th>{s.tasks.map((t) => <th key={t.id} className="px-1 py-1 text-center font-semibold">{t.short}</th>)}</tr></thead>
              <tbody>
                {(["Lapor koordinator", "Diterima divisi", "Selisih"] as const).map((label) => (
                  <tr key={label} className={`border-t border-slate-100 ${label === "Selisih" ? "bg-slate-50 font-semibold" : ""}`}>
                    <td className="px-2 py-1">{label}</td>
                    {s.tasks.map((t) => {
                      const c = s.crosscheck!.find((x) => x.taskId === t.id);
                      if (label === "Lapor koordinator") return <td key={t.id} className="px-1 py-1 text-center">{s.reports.length ? f(c?.reported ?? 0) : "—"}</td>;
                      if (label === "Diterima divisi") return <td key={t.id} className="px-1 py-1 text-center">{c?.received == null ? "—" : f(c.received)}</td>;
                      const n = c?.received == null || !s.reports.length ? null : c.received - c.reported;
                      return <td key={t.id} className={`px-1 py-1 text-center ${n ? "text-rose-700" : ""}`}>{n == null ? "—" : `${n > 0 ? "+" : ""}${f(n)}`}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.waiting && <p className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">{s.waiting === "laporan" ? "Menunggu laporan koordinator — upah & klaim belum bisa" : "Menunggu penerimaan divisi — upah & klaim belum bisa"}</p>}
        </section>
      )}

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

      {active.some((p) => p.counts.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Penerimaan divisi per jenis</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white text-sm">
            <table className="w-full tabular-nums">
              <thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-2 py-1 text-left">Jenis</th>{!s.resultAtReceipt && <th className="px-2 py-1 text-right">Dibagi</th>}{!s.resultAtReceipt && <th className="px-2 py-1 text-right">Setoran driver</th>}<th className="px-2 py-1 text-right">Diterima bagus</th><th className="px-2 py-1 text-right">Reject penerimaan</th>{!s.resultAtReceipt && <th className="px-2 py-1 text-right">Selisih</th>}</tr></thead>
              <tbody>
                {s.tasks.map((t) => {
                  const dibagi = s.cells.filter((c) => c.taskId === t.id).reduce((a, c) => a + c.dibagi, 0);
                  const driver = active.flatMap((p) => p.lines).filter((l) => l.taskId === t.id).reduce((a, l) => a + l.qty, 0);
                  const cs = active.flatMap((p) => p.counts).filter((c) => c.taskId === t.id);
                  const bagus = cs.reduce((a, c) => a + c.qty, 0);
                  const rej = cs.reduce((a, c) => a + (c.reject ?? 0), 0);
                  const gap = driver - bagus - rej;
                  return (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-medium">{t.short}</td>
                      {!s.resultAtReceipt && <td className="px-2 py-1 text-right">{f(dibagi)}</td>}
                      {!s.resultAtReceipt && <td className="px-2 py-1 text-right">{f(driver)}</td>}
                      <td className="px-2 py-1 text-right">{f(bagus)}</td>
                      <td className={`px-2 py-1 text-right ${rej ? "font-semibold text-rose-700" : ""}`}>{f(rej)}</td>
                      {!s.resultAtReceipt && <td className={`px-2 py-1 text-right ${gap ? "font-semibold text-rose-700" : ""}`}>{gap > 0 ? "+" : ""}{f(gap)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Reject penerimaan hanya dicatat: upah dan klaim tidak berubah. Selisih = setoran driver − diterima bagus − reject penerimaan.</p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Riwayat perubahan</h2>
        {!history.length ? <p className="text-sm text-slate-500">Belum ada catatan.</p> : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
            {history.map((h, i) => (
              <li key={i} className="space-y-0.5 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2"><b className="text-slate-800">{h.label}</b><span className="text-xs text-slate-500">{h.by} · {new Date(h.at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
                {h.text && <div className="break-words text-xs text-slate-600">{h.text}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!!gap && gap > 0 && patung && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Info untuk tim Oven: selisih {f(gap)} pcs pada kiriman ini. Ada kemungkinan salah hitung saat patung kering dimasukkan ke keranjang. Selisih ini hanya informasi dan tidak memotong upah siapa pun.</p>
      )}
    </div>
  );
}
