import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDateTime } from "@/lib/time";
import type { Scope } from "@/lib/borongan";
import { canRequestClaim, pointWageSummary } from "@/lib/boronganClaim";
import { isCoordinatorOf } from "@/lib/boronganFlow";
import { Badge, Empty, Field } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { CLAIM_STATUS_LABEL, CLAIM_TONE } from "./KlaimViews";
import { klaimSekarang, setujuiKlaim, tolakKlaim } from "./kirimanActions";

const rp = (n: number | bigint) => `Rp${Number(n).toLocaleString("id-ID")}`;

/** Titik yang upahnya boleh dilihat akun ini di tab Klaim Upah */
async function visiblePoints(scope: Scope, canPay: boolean) {
  const points = await prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, name: true, code: true } });
  const coords = await prisma.boronganPerson.findMany({ where: { role: "KOORDINATOR", active: true }, select: { pointId: true } });
  const has = (id: string) => coords.some((c) => c.pointId === id);
  return points
    .map((p) => ({ ...p, hasCoordinator: has(p.id) }))
    .filter((p) => scope.all || canPay || isCoordinatorOf(scope, p.id) || canRequestClaim(scope, p.id, p.hasCoordinator));
}

export async function KlaimTab({ scope, canPay }: { scope: Scope; canPay: boolean }) {
  const points = await visiblePoints(scope, canPay);
  const [summaries, waiting, banks] = await Promise.all([
    Promise.all(points.map(async (p) => ({ p, s: await pointWageSummary(p.id) }))),
    canPay ? prisma.boronganClaim.findMany({ where: { status: "MENUNGGU" }, include: { point: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    canPay ? prisma.bankAccount.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  if (!points.length) return <Empty title="Belum ada titik borongan" />;
  return (
    <div className="space-y-4">
      {canPay && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Klaim menunggu persetujuan</h2>
          {!waiting.length && <p className="text-sm text-slate-500">Tidak ada klaim yang menunggu.</p>}
          {waiting.map((c) => (
            <div key={c.id} className="card space-y-2 p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="break-all rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs font-semibold text-brand-700">{c.number}</span><Badge tone="amber">{c.auto ? "otomatis 7×" : "diajukan"}</Badge></div>
                <div className="mt-1 text-sm text-slate-700">{c.point.name} · <b>{rp(c.total)}</b> · {c.requestedBy} · {fmtDateTime(c.createdAt)}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/borongan/klaim/${c.id}`} className="btn-secondary btn-sm">Rincian</Link>
                <Modal trigger="Setujui & bayar" triggerClass="btn-primary btn-sm" title={`Setujui klaim ${c.number}`} subtitle={`${c.point.name} · ${rp(c.total)}`}>
                  <ModalForm action={setujuiKlaim} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <Field label="Bayar dari"><select name="bankAccountId" className="input" required>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                    <p className="text-xs text-slate-500">Upah pekerja & koordinator dibukukan sebagai beban gaji produksi, fee driver sebagai beban transport borongan.</p>
                    <Submit>Setujui & bayar</Submit>
                  </ModalForm>
                </Modal>
                <Modal trigger="Tolak" triggerClass="btn-secondary btn-sm" title={`Tolak klaim ${c.number}`}>
                  <ModalForm action={tolakKlaim} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <Field label="Alasan (wajib)"><textarea name="reason" rows={2} required minLength={3} className="input" /></Field>
                    <p className="text-xs text-slate-500">Setorannya kembali bisa diklaim setelah diperbaiki.</p>
                    <Submit className="btn-danger">Tolak klaim</Submit>
                  </ModalForm>
                </Modal>
              </div>
            </div>
          ))}
        </section>
      )}

      {summaries.map(({ p, s }) => {
        const b = s.breakdown;
        const can = canRequestClaim(scope, p.id, p.hasCoordinator);
        const pct = Math.min(100, Math.round((s.count / s.every) * 100));
        return (
          <section key={p.id} className="card space-y-3 p-3">
            <h2 className="text-base font-bold text-slate-900">Upah · {p.name}</h2>
            <div className="space-y-1">
              <div className="flex justify-between gap-2 text-sm"><span>Setoran sejak klaim terakhir</span><b className="tabular-nums">{s.count} dari {s.every}</b></div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={s.count} aria-valuemin={0} aria-valuemax={s.every} aria-label={`Setoran ${p.name}`}><div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} /></div>
              <p className="text-xs text-slate-500">Hanya setoran Assembling yang dihitung; Cat Giftbox ikut masuk klaim. Klaim otomatis dibuat setelah {s.every}× setoran.</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3 text-sm">
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Belum diklaim</p>
              <div className="flex justify-between gap-2"><span>Pekerja ({b.workers.length} orang)</span><b className="tabular-nums">{rp(b.totals.workers)}</b></div>
              <div className="flex justify-between gap-2"><span>Koordinator</span><b className="tabular-nums">{rp(b.totals.coordinators)}</b></div>
              <div className="flex justify-between gap-2"><span>Fee driver</span><b className="tabular-nums">{rp(b.totals.drivers)}</b></div>
              <div className="mt-1 flex justify-between gap-2 border-t border-slate-200 pt-1"><b>Total</b><b className="tabular-nums">{rp(b.totals.all)}</b></div>
              {s.held > 0 && <p className="mt-1 text-xs text-rose-700">{s.held} setoran ditahan (hitungan divisi kurang), belum ikut klaim.</p>}
            </div>
            {b.totals.all > 0 && <Link href={`/borongan/klaim/pratinjau?titik=${p.id}`} className="btn-secondary w-full">📄 Pratinjau pengajuan klaim (semua / per pekerja)</Link>}
            {can && b.totals.all > 0 && (
              <ActionForm action={klaimSekarang} confirm={`Ajukan klaim upah ${p.name} ${rp(b.totals.all)}?`}>
                <input type="hidden" name="pointId" value={p.id} />
                <Submit className="btn-primary w-full">Klaim Upah Sekarang</Submit>
              </ActionForm>
            )}
            {s.claims.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {s.claims.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <Link href={`/borongan/klaim/${c.id}`} className="break-all font-mono text-xs font-semibold text-brand-700 underline">{c.number}</Link>
                    <span className="tabular-nums">{rp(c.total)}</span>
                    <span className="ml-auto"><Badge tone={CLAIM_TONE[c.status]}>{CLAIM_STATUS_LABEL[c.status]}</Badge></span>
                    {c.rejectReason && <span className="w-full text-xs text-rose-700">Ditolak: {c.rejectReason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
