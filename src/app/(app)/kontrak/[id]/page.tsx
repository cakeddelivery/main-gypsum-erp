import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canManageContracts, canViewContract, contractSettings, type ContractSnapshot } from "@/lib/contract";
import { dateStr, fmtDateTime, fmtDay, todayStr } from "@/lib/time";
import { qrSvg } from "@/lib/qr";
import { baseUrl } from "@/lib/baseUrl";
import { Badge, Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport } from "@/components/DocSheet";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addendumAction, employeeSignAction, hrdSignAction, updateDraftAction, voidContractAction } from "../actions";
import { ContractDoc } from "../ContractDoc";
import { ContractFields } from "../ContractFields";
import { SignatureCard } from "../SignatureCard";

export const metadata = { title: "Kontrak kerja" };
const STATUS = { DRAFT: ["Draf", "gray"], HRD_TTD: ["Menunggu tanda tangan karyawan", "amber"], AKTIF: ["Terkunci", "green"], BATAL: ["Dibatalkan", "red"] } as const;

export default async function KontrakDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("hrd.manage", "payroll.self");
  const { id } = await params;
  const c = await prisma.contract.findUnique({ where: { id }, include: { employee: { select: { name: true } } } });
  if (!c || !canViewContract(user, c)) notFound();
  const hrd = canManageContracts(user);
  const snap = c.snapshot as unknown as ContractSnapshot;
  const verifyUrl = `${await baseUrl()}/verifikasi/${c.verifyCode}`;
  const qr = c.hrdSignedAt ? await qrSvg(verifyUrl, 92) : null;
  const [children, st] = await Promise.all([
    prisma.contract.findMany({ where: { parentId: c.id }, orderBy: { seq: "asc" }, select: { id: true, number: true, status: true } }),
    hrd ? contractSettings() : null,
  ]);
  const mine = !!user.employeeId && user.employeeId === c.employeeId;
  const [label, tone] = STATUS[c.status];
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${c.kind === "ADD" ? "Addendum" : "Kontrak"} ${c.number}`}
        subtitle={`${c.employee.name} · ${fmtDay(c.startDate)} – ${fmtDay(c.endDate)}`}
        actions={<><Link href="/kontrak" className="btn-secondary">Kembali</Link><DownloadJpg targetId="kontrak" filename={`kontrak-${c.number.replace(/\//g, "-")}`} label="👁 Baca kontrak" className="btn-primary" pdfHref={c.hrdSignedAt ? `/cetak/kontrak/${c.id}?print=1` : undefined} /></>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {c.lockedAt && <span className="text-xs text-slate-500">Terkunci {fmtDateTime(c.lockedAt)}; perubahan hanya lewat addendum.</span>}
      </div>

      {hrd && (
        <div className="flex flex-wrap gap-2">
          {c.status === "DRAFT" && (
            <>
              <Modal trigger="Ubah draf" triggerClass="btn-secondary" title="Ubah draf kontrak">
                <ModalForm action={updateDraftAction} className="space-y-3">
                  <input type="hidden" name="id" value={c.id} />
                  <ContractFields mode="edit" durations={st!.durations} today={todayStr()} initial={{ months: snap.term.months, start: snap.term.start, baseSalary: snap.pay.baseSalary, nik: snap.employee.nik, address: snap.employee.address }} />
                  <Submit>Simpan perubahan</Submit>
                </ModalForm>
              </Modal>
              <ActionForm action={hrdSignAction} confirm="Tandatangani sebagai HRD? Isi kontrak dibekukan dan QR verifikasi aktif.">
                <input type="hidden" name="id" value={c.id} />
                <Submit className="btn-primary" pendingText="…">✍ Tandatangani (HRD)</Submit>
              </ActionForm>
            </>
          )}
          {(c.status === "DRAFT" || c.status === "HRD_TTD") && (
            <Modal trigger="Batalkan kontrak" triggerClass="btn-secondary text-rose-700" title="Batalkan kontrak">
              <ModalForm action={voidContractAction} className="space-y-3">
                <input type="hidden" name="id" value={c.id} />
                <Field label="Alasan pembatalan"><textarea name="reason" className="input" rows={3} required minLength={3} /></Field>
                <Submit className="btn-danger">Batalkan</Submit>
              </ModalForm>
            </Modal>
          )}
          {c.status === "AKTIF" && c.kind === "PKWT" && (
            <Modal trigger="+ Buat addendum" triggerClass="btn-secondary" title="Addendum bernomor">
              <ModalForm action={addendumAction} className="space-y-3">
                <input type="hidden" name="id" value={c.id} />
                <Field label="Berlaku mulai"><input type="date" name="start" className="input" required defaultValue={todayStr()} /></Field>
                <Field label="Isi perubahan"><textarea name="text" className="input" rows={4} required minLength={5} placeholder="Mis. Para pihak sepakat mengubah gaji pokok…" /></Field>
                <Field label="Gaji pokok baru (Rp, opsional)"><input name="baseSalary" className="input" inputMode="numeric" /></Field>
                <Field label="Tanggal selesai baru (opsional)"><input type="date" name="endDate" className="input" min={dateStr(c.endDate)} /></Field>
                <Submit>Buat draf addendum</Submit>
              </ModalForm>
            </Modal>
          )}
        </div>
      )}

      {mine && c.status === "HRD_TTD" && (
        <section className="card space-y-3 p-4">
          <h3 className="font-bold text-slate-800">Tandatangani kontrak Anda</h3>
          <p className="text-sm text-slate-600">Ketuk <b>Baca kontrak</b> di bagian atas untuk membaca seluruh isinya. Setelah ditandatangani, kontrak <b>terkunci</b> dan tidak dapat diubah.</p>
          <ActionForm action={employeeSignAction} className="space-y-3">
            <input type="hidden" name="id" value={c.id} />
            <SignatureCard />
          </ActionForm>
        </section>
      )}

      {c.contentHash && hrd && (
        <p className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-500">Hash isi: {c.contentHash}{c.finalHash && <><br />Hash akhir: {c.finalHash}</>}</p>
      )}

      <DocExport><ContractDoc doc={{ ...c, kind: c.kind }} qr={qr} verifyUrl={verifyUrl} /></DocExport>

      {children.length > 0 && (
        <div className="text-sm">Addendum: {children.map((a) => <Link key={a.id} href={`/kontrak/${a.id}`} className="link mr-3 font-mono text-xs">{a.number}</Link>)}</div>
      )}
      {c.parentId && <div className="text-sm">Addendum dari <Link href={`/kontrak/${c.parentId}`} className="link">kontrak induk</Link></div>}
    </div>
  );
}
