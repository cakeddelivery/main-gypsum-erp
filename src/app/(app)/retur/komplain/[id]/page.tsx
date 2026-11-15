import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, fmtDateTime, todayStr } from "@/lib/time";
import { canSeePayee, refundLimit } from "@/lib/complaints";
import { complaintStatusOf, COMPLAINT_STATUS, issueLabel, solutionLabel } from "@/lib/complaintShared";
import { marketplaceLabel } from "@/lib/returnLabel";
import { fmtBytes } from "@/lib/mediaStore";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { addEvidenceAction, approveAction, cancelComplaintAction, finishComplaintAction, payAction, rejectAction, resendProofAction, sendReplacementAction } from "../actions";

export const metadata = { title: "Detail Komplain" };
const media = (id: string) => `/api/files/komplain-media/${id}`;

export default async function KomplainDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("refund.request", "refund.approve", "refund.pay");
  const { id } = await params;
  const c = await prisma.complaint.findUnique({ where: { id }, include: { lines: { include: { item: { select: { name: true } } }, orderBy: { sortOrder: "asc" } }, media: { orderBy: { createdAt: "asc" } } } });
  if (!c) notFound();
  const st = complaintStatusOf(c);
  const open = !c.cancelledAt && c.status !== "SELESAI" && c.status !== "DITOLAK";
  const refund = c.solution === "REFUND";
  const seePayee = canSeePayee(c, user);
  const [limit, banks, tx, ret] = await Promise.all([
    refundLimit(),
    c.status === "DISETUJUI" && user.can("refund.pay") ? prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, orderBy: { code: "asc" } }) : [],
    c.payJournalId ? prisma.financeTransaction.findFirst({ where: { journalId: c.payJournalId }, select: { id: true, number: true } }) : null,
    c.trackingNo ? prisma.returnCase.findFirst({ where: { trackingNo: c.trackingNo, cancelledAt: null }, select: { id: true, number: true } }) : null,
  ]);
  const owner = user.role === "OWNER";
  const canApprove = user.can("refund.approve") && refund && (c.status === "DIAJUKAN" || (c.status === "MENUNGGU_OWNER" && owner));
  const info: [string, React.ReactNode][] = [
    ["Tanggal", fmtDate(c.date)], ["Marketplace", marketplaceLabel(c.marketplace)], ["No. pesanan", c.orderNo ?? "-"], ["No. resi", c.trackingNo ?? "-"],
    ["Tujuan", [c.city, c.province].filter(Boolean).join(", ") || "-"], ["Masalah", issueLabel(c.issueType)], ...(c.description ? [["Keterangan", c.description] as [string, string]] : []),
    ["Solusi", `${solutionLabel(c.solution)}${c.bundleNext ? " — dibarengkan pesanan berikutnya" : ""}`], ["Diajukan", `${c.createdBy} · ${fmtDateTime(c.createdAt)}`],
    ...(ret ? [["Retur terkait", <Link key="r" href={`/retur/${ret.id}`} className="text-brand-600 underline">{ret.number}</Link>] as [string, React.ReactNode]] : []),
    ...(c.approvedAt ? [["Disetujui Finance", `${c.approvedBy} · ${fmtDateTime(c.approvedAt)}`] as [string, string]] : []),
    ...(c.ownerApprovedAt ? [["Disetujui Owner", `${c.ownerApprovedBy} · ${fmtDateTime(c.ownerApprovedAt)}`] as [string, string]] : []),
    ...(c.rejectedAt ? [["Ditolak", `${c.rejectedBy} · ${fmtDateTime(c.rejectedAt)} — ${c.rejectReason}`] as [string, string]] : []),
    ...(c.paidAt ? [["Dibayar", `${c.paidBy} · ${fmtDate(c.paidAt)}`] as [string, string]] : []),
    ...(c.sentAt ? [["Pengganti dikirim", `${c.sentBy} · ${fmtDateTime(c.sentAt)}`] as [string, string]] : []),
    ...(c.doneAt ? [["Selesai", `${c.doneBy} · ${fmtDateTime(c.doneAt)}`] as [string, string]] : []),
    ...(c.cancelledAt ? [["Dibatalkan", `${fmtDateTime(c.cancelledAt)} — ${c.cancelReason}`] as [string, string]] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Komplain ${c.number}`}
        subtitle={<>{solutionLabel(c.solution)}{refund ? ` ${idr(Number(c.refundAmount))}` : ""} · <Badge tone={st.tone}>{st.label}</Badge></>}
        actions={<>
          <Link href="/retur/komplain" className="btn-secondary">Kembali</Link>
          {!c.cancelledAt && user.can("refund.approve") && (
            <Modal trigger="Batalkan" title={`Batalkan ${c.number}`} triggerClass="btn-secondary">
              <ModalForm action={cancelComplaintAction} className="space-y-3">
                <input type="hidden" name="id" value={c.id} />
                <p className="text-sm">Untuk komplain salah input. Refund yang sudah dibayar / pengganti yang sudah dikirim dibalik (jurnal balik, stok kembali). Data tetap tersimpan.</p>
                <Field label="Alasan"><input name="reason" className="input" required /></Field>
                <Submit className="btn-danger">Batalkan komplain</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Data komplain">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {info.map(([k, v]) => <Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></Fragment>)}
          </dl>
        </Card>

        <Card title={refund ? "Refund" : "Kirim ganti"}>
          <div className="space-y-3 text-sm">
            {refund && (seePayee ? (
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">🔒 Rekening pembeli (hanya pengaju, Finance, Owner)</p>
                <p className="mt-1 font-medium">{c.payeeBank} · <span className="font-mono">{c.payeeAccount}</span></p>
                <p>a.n. {c.payeeName}</p>
                <p className="mt-1">Nominal <b>{idr(Number(c.refundAmount))}</b>{Number(c.refundAmount) > limit ? ` (di atas batas ${idr(limit)}: perlu Owner)` : ""}</p>
              </div>
            ) : <p className="text-slate-500">Rekening pembeli disembunyikan. Nominal {idr(Number(c.refundAmount))}.</p>)}
            {refund && c.proofPath && seePayee && <p>Bukti bayar: <a href={`/api/files/komplain-proof/${c.id}`} target="_blank" rel="noreferrer" className="text-brand-600 underline">lihat</a>{tx && <> · <Link href={`/finance/${tx.id}`} className="text-brand-600 underline">{tx.number}</Link></>}{c.proofSentAt ? ` · terkirim ke pengaju ${fmtDateTime(c.proofSentAt)}` : ""}</p>}
            {!refund && Number(c.replacementValue) > 0 && <p>Nilai barang pengganti {idr(Number(c.replacementValue))} (beban garansi).</p>}
            <div className="flex flex-wrap gap-2">
              {canApprove && (
                <Modal trigger={c.status === "MENUNGGU_OWNER" ? "Setujui (Owner)" : "Setujui refund"} title={`Setujui ${c.number}`}>
                  <ModalForm action={approveAction} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <p className="text-sm">Refund {idr(Number(c.refundAmount))} ke {seePayee ? `${c.payeeBank} ${c.payeeAccount} a.n. ${c.payeeName}` : "rekening pembeli"}.{Number(c.refundAmount) > limit && !owner ? " Setelah ini menunggu persetujuan Owner." : ""}</p>
                    <Submit>Setujui</Submit>
                  </ModalForm>
                </Modal>
              )}
              {open && user.can("refund.approve") && ["DIAJUKAN", "MENUNGGU_OWNER", "DISETUJUI"].includes(c.status) && (
                <Modal trigger="Tolak" title={`Tolak ${c.number}`} triggerClass="btn-secondary">
                  <ModalForm action={rejectAction} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <Field label="Alasan ditolak"><input name="reason" className="input" required /></Field>
                    <Submit className="btn-danger">Tolak</Submit>
                  </ModalForm>
                </Modal>
              )}
              {c.status === "DISETUJUI" && user.can("refund.pay") && (
                <Modal trigger="Bayar refund" title={`Bayar refund ${c.number}`}>
                  <ModalForm action={payAction} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <p className="text-sm">Transfer <b>{idr(Number(c.refundAmount))}</b> ke {c.payeeBank} <span className="font-mono">{c.payeeAccount}</span> a.n. {c.payeeName}. Tercatat sebagai pengeluaran «Retur & Refund Penjualan»; bukti dikirim bot ke {c.createdBy}.</p>
                    <Field label="Tanggal bayar"><input type="date" name="date" defaultValue={todayStr()} className="input" required /></Field>
                    <Field label="Rekening sumber"><select name="bankAccountId" className="input" required defaultValue={banks.find((b) => b.code === "SEABANK")?.id ?? banks[0]?.id}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                    <Field label="Bukti transfer *"><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" required className="block w-full min-w-0 max-w-full text-base" /></Field>
                    <Submit>Simpan pembayaran</Submit>
                  </ModalForm>
                </Modal>
              )}
              {c.paidAt && !c.proofSentAt && !c.cancelledAt && user.can("refund.pay") && (
                <ModalForm action={resendProofAction}><input type="hidden" name="id" value={c.id} /><Submit className="btn-secondary btn-sm">Kirim ulang bukti ke pengaju</Submit></ModalForm>
              )}
              {!refund && c.status === "DIAJUKAN" && !c.cancelledAt && user.can("refund.request") && (
                <Modal trigger="Pengganti dikirim" title={`Kirim pengganti ${c.number}`}>
                  <ModalForm action={sendReplacementAction} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <p className="text-sm">Barang pengganti keluar dari gudang barang jadi dan dicatat sebagai Beban Garansi & Penggantian Barang:</p>
                    <ul className="list-disc pl-5 text-sm">{c.lines.filter((l) => l.sendQty > 0).map((l) => <li key={l.id}>{l.item?.name ?? l.labelSku} × {l.sendQty}</li>)}</ul>
                    <Submit>Ya, sudah dikirim</Submit>
                  </ModalForm>
                </Modal>
              )}
              {open && (c.status === "DIBAYAR" || c.status === "DIKIRIM") && (user.can("refund.request") || user.can("refund.pay")) && (
                <ModalForm action={finishComplaintAction}><input type="hidden" name="id" value={c.id} /><Submit className="btn-secondary">Tandai selesai</Submit></ModalForm>
              )}
            </div>
            <p className="text-xs text-slate-500">Alur refund: Diajukan → Disetujui Finance → (Owner bila &gt; {idr(limit)}) → Dibayar → Selesai. Kirim ganti: Diajukan → {COMPLAINT_STATUS.DIKIRIM.label} → Selesai.</p>
          </div>
        </Card>
      </div>

      <Card title="Barang bermasalah">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Produk</th><th>Label</th><th className="num">Qty bermasalah</th>{!refund && <th className="num">Pengganti</th>}</tr></thead>
            <tbody>{c.lines.map((l) => <tr key={l.id}><td>{l.item?.name ?? "-"}</td><td className="text-xs">{[l.labelSku, l.labelName].filter(Boolean).join(" · ") || "-"}</td><td className="num">{l.qty}</td>{!refund && <td className="num">{l.sendQty}</td>}</tr>)}</tbody>
          </table>
        </div>
      </Card>

      <Card title="Bukti dari pembeli" actions={!c.cancelledAt ? (
        <Modal trigger="+ Bukti" title="Tambah bukti" triggerClass="btn-secondary btn-sm">
          <ModalForm action={addEvidenceAction} className="space-y-3">
            <input type="hidden" name="id" value={c.id} />
            <Field label="Foto / video (total maks 15 MB)"><input type="file" name="evidence" accept="image/*,video/*" multiple required className="block w-full min-w-0 max-w-full text-base" /></Field>
            <Submit>Unggah</Submit>
          </ModalForm>
        </Modal>
      ) : undefined}>
        {c.media.length === 0 ? <p className="text-sm text-slate-500">Belum ada bukti.</p> : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {c.media.map((m) => m.mime.startsWith("video/")
              ? <video key={m.id} src={media(m.id)} controls preload="none" playsInline className="aspect-square w-full rounded bg-black object-cover" />
              : <a key={m.id} href={media(m.id)} target="_blank" rel="noreferrer"><img src={media(m.id)} alt="Bukti" loading="lazy" className="aspect-square w-full rounded object-cover" /></a>)}
          </div>
        )}
        {c.media.length > 0 && <p className="mt-2 text-xs text-slate-500">{c.media.length} file · {fmtBytes(c.media.reduce((s, m) => s + m.size, 0))}</p>}
      </Card>
    </div>
  );
}
