import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { dateOnly, fmtDay } from "@/lib/time";
import { STATE_LABEL, canViewShipment, forCoordinator, fullAccess, isCoordinatorScope, shipmentView } from "@/lib/boronganFlow";
import { boronganScope } from "@/lib/borongan";
import { prisma } from "@/lib/db";
import { isAssemblingTask } from "@/lib/boronganClaim";
import { Badge, PageHeader } from "@/components/ui";
import { WorkerCard } from "../../KirimanForms";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { EditKirimanForm } from "../../EditKirimanForm";
import { batalKiriman, ubahKiriman } from "../../kirimanActions";
import { Submit } from "@/components/ActionForm";
import { fmtDateTime } from "@/lib/time";
import { canSeeHistory } from "../access";

export const metadata = { title: "Detail kiriman borongan" };
const f = (n: number) => n.toLocaleString("id-ID");
const LOG: Record<string, string> = { KIRIMAN_DIUBAH: "Kiriman diubah", KIRIMAN_JUMLAH_DIUBAH: "Jumlah diubah", KIRIMAN_BORONGAN_DIBATALKAN: "Kiriman dibatalkan", PEMBAGIAN_BORONGAN: "Pembagian disimpan" };
const PICKUP = { DIBAWA: ["menunggu dihitung", "amber"], DITERIMA: ["cocok / diterima", "green"], KURANG: ["kurang, upah ditahan", "red"], DIBATALKAN: ["dibatalkan", "gray"] } as const;

/** Detail satu kiriman: ringkasan angka, bahan dikirim, tabel per pekerja, setiap pengambilan, info untuk tim Oven */
export default async function KirimanDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("borongan.view", "borongan.point", "borongan.manage", "borongan.driver");
  // Semua pengguna borongan boleh membuka detail sesuai hak lihatnya: pengelola & tim divisi penuh;
  // koordinator hanya titiknya; driver hanya kiriman lewat driver; selain itu disaring canViewShipment
  const full = await canSeeHistory(user);
  const scope = await boronganScope(prisma, user);
  const raw = await shipmentView((await params).id);
  if (!raw) notFound();
  let s = raw;
  if (!scope.all && !full) {
    if (isCoordinatorScope(scope)) {
      const c = forCoordinator(raw, scope.pointIds);
      if (!c) notFound();
      s = c;
    } else if (!canViewShipment(scope, raw)) notFound();
  }
  const admin = fullAccess(scope);
  const coordView = !scope.all && isCoordinatorScope(scope);
  const logs = admin || full ? await prisma.auditLog.findMany({ where: { entity: "BoronganShipment", entityId: s.id, action: { in: ["KIRIMAN_DIUBAH", "KIRIMAN_JUMLAH_DIUBAH", "KIRIMAN_BORONGAN_DIBATALKAN", "PEMBAGIAN_BORONGAN"] } }, orderBy: { at: "desc" }, take: 50 }) : [];
  const finished = !!s.closed || (!s.waitingSupport && s.state === "SELESAI");
  const edit = admin && !s.cancelled ? await (async () => {
    const [points, drivers, items, paid] = await Promise.all([
      prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.boronganPerson.findMany({ where: { role: "DRIVER", active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.item.findMany({ where: { active: true, type: { in: ["BAHAN_BAKU", "BARANG_DALAM_PROSES"] } }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: true } }),
      prisma.boronganResult.count({ where: { pickup: { shipmentId: s.id }, OR: [{ claimId: { not: null } }, { settlementId: { not: null } }] } }),
    ]);
    return { points, drivers, items, paid: paid > 0 };
  })() : null;
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
        {edit && (
          <Modal trigger="Ubah kiriman" triggerClass="btn-primary btn-sm" title="Ubah kiriman" subtitle={`${s.number} · ${s.group}`} wide>
            <ModalForm action={ubahKiriman} className="space-y-3"><EditKirimanForm view={s} points={edit.points} drivers={edit.drivers} items={edit.items} finished={finished} paid={edit.paid} /></ModalForm>
          </Modal>
        )}
        {edit && !finished && active.length === 0 && (
          <Modal trigger="Batalkan kiriman" triggerClass="btn-secondary btn-sm text-rose-600" title="Batalkan kiriman" subtitle={s.number}>
            <ModalForm action={batalKiriman} className="space-y-3" confirm={`Batalkan kiriman ${s.number}? Bahan kembali ke gudang.`}>
              <input type="hidden" name="id" value={s.id} />
              <p className="text-sm text-slate-600">Semua bahan kembali ke gudang (mutasi pembalik). Hanya bisa selama belum ada pengambilan setoran.</p>
              <label className="block"><span className="label">Alasan (wajib)</span><input name="reason" className="input" required minLength={3} /></label>
              <Submit className="btn-danger">Batalkan kiriman</Submit>
            </ModalForm>
          </Modal>
        )}
        <Link href={full ? "/borongan/riwayat" : "/borongan?tab=kiriman"} className="ml-auto text-sm font-semibold text-brand-700 underline">← {full ? "Riwayat" : "Kiriman"}</Link>
      </div>

      <dl className="card grid gap-x-4 gap-y-1 p-3 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Nomor</dt><dd className="font-mono font-semibold">{s.number}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Tanggal</dt><dd>{fmtDay(dateOnly(s.date))}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Tugas</dt><dd className="text-right">{s.group}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Titik</dt><dd className="text-right">{s.points.map((p) => p.name).join(", ") || "—"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Cara kirim</dt><dd className="text-right">{s.mode === "DRIVER" ? `Lewat driver${s.driver ? ` (${s.driver})` : ""}` : "Diantar langsung"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Dicatat</dt><dd className="text-right">{s.createdBy}</dd></div>
        {s.note && <div className="sm:col-span-2"><dt className="text-slate-500">Catatan</dt><dd className="break-words">{s.note}</dd></div>}
        {s.closed && <div className="sm:col-span-2 text-slate-600">Ditutup: {s.closed}</div>}
      </dl>

      <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
        {[["Dikirim", f(s.totals.sent), false], ["Setoran diterima", f(s.totals.received), false], ["Reject", f(s.totals.reject), false], [gap == null ? "Masih di pekerja" : "Selisih", gap == null ? f(s.totals.atWorkers) : f(gap), !!gap]].map(([k, v, bad]) => (
          <div key={String(k)} className={`rounded-xl p-3 ${bad ? "bg-rose-50 text-rose-700" : "bg-slate-50"}`}>
            <div className="text-xs font-semibold text-slate-500">{k}</div>
            <div className="text-2xl font-extrabold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Bahan yang dikirim</h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
          {s.tasks.length > 0 && !s.resultAtReceipt && <div className="bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">Jumlah per varian</div>}
          {!s.resultAtReceipt && s.tasks.map((t) => <div key={t.id} className="flex justify-between gap-2 border-b border-slate-100 px-3 py-1.5"><span>{t.short}</span><b className="tabular-nums">{f(t.qty)} pcs</b></div>)}
          {s.resultAtReceipt && <div className="bg-slate-50 px-3 py-1 text-xs text-slate-500">Jenis: {s.tasks.map((t) => t.short).join(", ")} · hasil per warna diisi saat penerimaan</div>}
          {!s.lines.length && <div className="px-3 py-2 text-slate-500">{s.waitingSupport ? "Bahan belum dilengkapi." : "Tidak ada bahan tercatat."}</div>}
          {s.lines.length > 0 && <div className="bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">Bahan (nama · jumlah · satuan)</div>}
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

      {s.resultAtReceipt && s.crosscheck && s.crosscheck.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Kroscek koordinator vs divisi</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white text-sm">
            <table className="w-full tabular-nums"><thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-2 py-1 text-left">Jenis</th><th className="px-2 py-1 text-right">Lapor</th><th className="px-2 py-1 text-right">Diterima</th><th className="px-2 py-1 text-right">Selisih</th></tr></thead>
              <tbody>{s.crosscheck.map((c) => <tr key={`${c.pointId}${c.taskId}`} className="border-t border-slate-100"><td className="px-2 py-1">{short(c.taskId)}{s.points.length > 1 ? ` · ${pname(c.pointId)}` : ""}</td><td className="px-2 py-1 text-right">{f(c.reported)}</td><td className="px-2 py-1 text-right">{c.received == null ? "—" : f(c.received)}</td><td className={`px-2 py-1 text-right ${c.received != null && c.received !== c.reported ? "font-semibold text-rose-700" : ""}`}>{c.received == null ? "—" : f(c.received - c.reported)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      {logs.length > 0 && !coordView && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Riwayat perubahan</h2>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
            {logs.map((l) => {
              const d = (l.data ?? {}) as Record<string, unknown>;
              const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join(", ") : String(v));
              return (
                <li key={String(l.id)} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500"><b className="text-slate-700">{LOG[l.action] ?? l.action}</b><span>{fmtDateTime(l.at)}</span><span>{l.actorName}</span></div>
                  {typeof d.alasan === "string" && <div className="text-xs text-slate-600">Alasan: {d.alasan}</div>}
                  {(l.action === "KIRIMAN_DIUBAH" || l.action === "KIRIMAN_JUMLAH_DIUBAH") && d.sesudah != null && typeof d.sesudah === "object" && (
                    l.action === "KIRIMAN_DIUBAH"
                      ? <ul className="mt-1 space-y-0.5 text-xs">{Object.keys(d.sesudah as object).map((k) => <li key={k} className="break-words"><b>{k}</b>: <span className="text-slate-500 line-through">{show((d.sebelum as Record<string, unknown> | undefined)?.[k])}</span> → {show((d.sesudah as Record<string, unknown>)[k])}</li>)}</ul>
                      : <div className="mt-1 break-words text-xs"><span className="text-slate-500 line-through">{show(d.sebelum)}</span> → {show(d.sesudah)}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!!gap && gap > 0 && patung && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Info untuk tim Oven: selisih {f(gap)} pcs pada kiriman ini. Ada kemungkinan salah hitung saat patung kering dimasukkan ke keranjang. Selisih ini hanya informasi dan tidak memotong upah siapa pun.</p>
      )}
    </div>
  );
}
