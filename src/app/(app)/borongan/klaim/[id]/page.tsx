import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { claimDetail } from "@/lib/boronganClaim";
import { fmtDateTime } from "@/lib/time";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { canSeeClaim } from "../access";
import { claimDoc } from "../pratinjau/data";
import { ClaimPreview } from "../pratinjau/ClaimPreview";
import { setujuiKlaim, tolakKlaim } from "../../kirimanActions";

export const metadata = { title: "Klaim upah borongan" };
const rp = (n: number | bigint) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default async function KlaimPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ pekerja?: string }> }) {
  const user = await requirePerm("borongan.view");
  const { id } = await params;
  const c = await claimDetail(id);
  if (!c || !(await canSeeClaim(user, c.pointId))) notFound();
  const canPay = user.can("borongan.pay") && c.status === "MENUNGGU";
  const banks = canPay ? await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const lh = await letterhead();
  const d = (await claimDoc({ claimId: c.id, workerId: (await searchParams).pekerja || null }))!;
  const pay = canPay && (
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
  );
  const q = new URLSearchParams({ klaim: c.id, ...(d.worker ? { pekerja: d.worker.id } : {}) });
  return (
    <>
      <p className="mx-auto mb-2 max-w-3xl text-sm text-slate-600">{c.auto ? "Dibuat otomatis setelah 7× setoran" : `Diajukan ${c.requestedBy}`} · {fmtDateTime(c.createdAt)}{c.settlement ? ` · dibayar ${c.settlement.number} oleh ${c.decidedBy}` : ""}{c.rejectReason ? ` · ditolak ${c.decidedBy}: ${c.rejectReason}` : ""}</p>
      <ClaimPreview d={d} lh={lh} base={`/borongan/klaim/${c.id}`} printHref={`/cetak/klaim/pratinjau?${q}&print=1`} actions={pay} />
    </>
  );
}
