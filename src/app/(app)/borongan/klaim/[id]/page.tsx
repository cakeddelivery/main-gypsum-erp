import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { claimDetail } from "@/lib/boronganClaim";
import { fmtDateTime } from "@/lib/time";
import { Badge, Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport } from "@/components/DocSheet";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { ClaimTable, CLAIM_STATUS_LABEL, CLAIM_TONE } from "../../KlaimViews";
import { ClaimSheet } from "../ClaimSheet";
import { canSeeClaim } from "../access";
import { setujuiKlaim, tolakKlaim } from "../../kirimanActions";

export const metadata = { title: "Klaim upah borongan" };
const rp = (n: number | bigint) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default async function KlaimPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("borongan.view");
  const { id } = await params;
  const c = await claimDetail(id);
  if (!c || !(await canSeeClaim(user, c.pointId))) notFound();
  const canPay = user.can("borongan.pay") && c.status === "MENUNGGU";
  const banks = canPay ? await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const lh = await letterhead();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Klaim ${c.point.name}`} subtitle={`${c.number} · ${c.auto ? "otomatis setelah 7× setoran" : `diajukan ${c.requestedBy}`} · ${fmtDateTime(c.createdAt)}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CLAIM_TONE[c.status]}>{CLAIM_STATUS_LABEL[c.status]}</Badge>
        {c.settlement && <span className="text-sm text-slate-600">dibayar {c.settlement.number} oleh {c.decidedBy}</span>}
        {c.rejectReason && <span className="text-sm text-rose-700">Ditolak {c.decidedBy}: {c.rejectReason}</span>}
      </div>
      <ClaimTable b={c.breakdown} />
      <div className="flex flex-wrap gap-2">
        <DownloadJpg targetId="klaim-doc" filename={`${c.number}.jpg`} label="🖼️ Unduh JPG" />
        <a href={`/cetak/klaim/${c.id}?print=1`} target="_blank" rel="noopener" className="btn-secondary">📄 Unduh PDF</a>
        <Link href="/borongan?tab=klaim" className="btn-secondary">Kembali</Link>
      </div>
      {canPay && (
        <div className="flex flex-wrap gap-2">
          <Modal trigger="Setujui & bayar" title={`Setujui klaim ${c.number}`} subtitle={`${c.point.name} · ${rp(c.total)}`}>
            <ModalForm action={setujuiKlaim} className="space-y-3">
              <input type="hidden" name="id" value={c.id} />
              <Field label="Bayar dari"><select name="bankAccountId" className="input" required>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
              <Submit>Setujui & bayar</Submit>
            </ModalForm>
          </Modal>
          <Modal trigger="Tolak" triggerClass="btn-secondary" title={`Tolak klaim ${c.number}`}>
            <ModalForm action={tolakKlaim} className="space-y-3">
              <input type="hidden" name="id" value={c.id} />
              <Field label="Alasan (wajib)"><textarea name="reason" rows={2} required minLength={3} className="input" /></Field>
              <Submit className="btn-danger">Tolak klaim</Submit>
            </ModalForm>
          </Modal>
        </div>
      )}
      <DocExport><ClaimSheet c={c} lh={lh} id="klaim-doc" /></DocExport>
    </div>
  );
}
