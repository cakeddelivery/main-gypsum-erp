import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { contractSettings } from "@/lib/contract";
import { baseUrl } from "@/lib/baseUrl";
import { qrSvg } from "@/lib/qr";
import { idr } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { TERMINATION_REASONS, type Line, type TerminationReason } from "@/lib/terminationCalc";
import { Badge, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport } from "@/components/DocSheet";
import { issueTerminationAction, voidTerminationAction } from "../actions";
import { TerminationDoc } from "../TerminationDoc";

export const metadata = { title: "Pengakhiran kontrak" };
const ST = { DRAFT: ["Draf", "gray"], DITERBITKAN: ["Diterbitkan", "green"], BATAL: ["Dibatalkan", "red"] } as const;

export default async function PengakhiranDetail({ params }: { params: Promise<{ id: string }> }) {
  await requirePerm("hrd.manage");
  const { id } = await params;
  const t = await prisma.termination.findUnique({ where: { id }, include: { employee: { select: { name: true, division: { select: { name: true } } } } } });
  if (!t) notFound();
  const [lh, st] = await Promise.all([letterhead(), contractSettings()]);
  const verifyUrl = `${await baseUrl()}/verifikasi/${t.verifyCode}`;
  const qr = t.issuedAt ? await qrSvg(verifyUrl, 92) : null;
  const calc = t.calc as unknown as { lines: Line[]; net: number; warnings: string[] };
  const [label, tone] = ST[t.status];
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Pengakhiran ${t.number}`}
        subtitle={`${t.employee.name} · ${TERMINATION_REASONS[t.reason as TerminationReason]} · efektif ${fmtDay(t.effectiveDate)}`}
        actions={<>
          <Link href="/kontrak/pengakhiran" className="btn-secondary">Kembali</Link>
          <DownloadJpg targetId="pengakhiran" filename={`pengakhiran-${t.number.replace(/\//g, "-")}`} label="👁 Lihat surat & slip akhir" className="btn-primary" pdfHref={t.issuedAt ? `/cetak/pengakhiran/${t.id}?print=1` : undefined} />
        </>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {t.evidencePath && <a href={`/api/files/pengakhiran/${t.id}`} target="_blank" className="link text-sm">📎 Lihat lampiran bukti</a>}
      </div>
      {calc.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{calc.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}</ul>
      )}
      <div className="card space-y-1.5 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Slip akhir</h3>
        {calc.lines.map((l) => (
          <div key={l.key} className="flex justify-between gap-3 text-sm"><span>{l.label}</span><b className={`tabular-nums ${l.kind === "minus" ? "text-rose-700" : ""}`}>{l.kind === "minus" ? "−" : ""}{idr(l.amount)}</b></div>
        ))}
        <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold"><span>Total dibayarkan</span><span className="tabular-nums">{idr(calc.net)}</span></div>
      </div>
      {t.status === "DRAFT" && (
        <div className="flex flex-wrap gap-2">
          <ActionForm action={issueTerminationAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={t.id} />
            {t.reason === "DIPUTUS_PERUSAHAAN" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirmValue" value="1" required /> Saya sudah memeriksa nilai ganti rugi ({idr(calc.net)})</label>}
            <Submit className="btn-primary" pendingText="…" confirm="Terbitkan surat? Tanggal berhenti karyawan diatur otomatis dan hitungan dibekukan.">✍ Terbitkan (tandatangani HRD)</Submit>
          </ActionForm>
          <Modal trigger="Batalkan" triggerClass="btn-secondary text-rose-700" title="Batalkan pengakhiran">
            <ModalForm action={voidTerminationAction} className="space-y-3">
              <input type="hidden" name="id" value={t.id} />
              <Field label="Alasan pembatalan"><textarea name="reason" className="input" rows={3} required minLength={3} /></Field>
              <Submit className="btn-danger">Batalkan</Submit>
            </ModalForm>
          </Modal>
        </div>
      )}
      {t.status === "DITERBITKAN" && (
        <Modal trigger="Batalkan surat" triggerClass="btn-secondary text-rose-700" title="Batalkan surat pengakhiran">
          <ModalForm action={voidTerminationAction} className="space-y-3">
            <input type="hidden" name="id" value={t.id} />
            <Field label="Alasan pembatalan (tercatat)"><textarea name="reason" className="input" rows={3} required minLength={3} /></Field>
            <Submit className="btn-danger">Batalkan</Submit>
          </ModalForm>
        </Modal>
      )}
      <DocExport><TerminationDoc t={t} lh={lh} hrdName={st.hrd.name} qr={qr} division={t.employee.division.name} /></DocExport>
    </div>
  );
}
