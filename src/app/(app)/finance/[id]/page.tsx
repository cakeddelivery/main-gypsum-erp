import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { dateStr, fmtDateTime, jakartaParts } from "@/lib/time";
import { STATUS_LABEL, missingFields } from "@/lib/finance";
import { Badge, Card, ErrorBox, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { TxForm } from "../TxForm";
import { approveTx, rejectTx, submitTx, updateTx } from "../actions";

export const metadata = { title: "Detail Transaksi" };

export default async function TxDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ dup?: string }> }) {
  const user = await requirePerm("finance.view");
  const { id } = await params;
  const t = await prisma.financeTransaction.findUnique({ where: { id }, include: { approvals: { orderBy: { at: "asc" } }, store: true } });
  if (!t) notFound();
  const [banks, categories, stores, dup, journal] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.store.findMany({ where: { active: true } }),
    t.duplicateOfId ? prisma.financeTransaction.findUnique({ where: { id: t.duplicateOfId } }) : null,
    t.journalId ? prisma.journal.findUnique({ where: { id: t.journalId }, include: { lines: { include: { account: true } } } }) : null,
  ]);
  const editable = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status);
  const missing = missingFields(t);
  const p = jakartaParts(t.date);
  const suggested = categories.find((c) => c.id === t.suggestedCategoryId);
  const ai = t.aiExtraction as { confidence?: number; missing?: string[] } | null;
  return (
    <div className="space-y-5">
      <PageHeader title={`Transaksi ${t.number}`} subtitle={`${idr(t.amount)} · ${fmtDateTime(t.date)} · dibuat ${t.createdBy}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={t.status === "DIBUKUKAN" ? "green" : t.status === "DITOLAK" ? "red" : t.status === "MENUNGGU_KONFIRMASI" ? "blue" : "amber"}>{STATUS_LABEL[t.status]}</Badge>
        <Badge>{t.source}</Badge>
        {t.store && <Badge tone="purple">{t.store.name}</Badge>}
        {suggested && <span className="text-xs text-slate-500">Rekomendasi kategori: <b>{suggested.name}</b></span>}
        {ai?.confidence !== undefined && <span className="text-xs text-slate-500">Keyakinan ekstraksi {Math.round(ai.confidence * 100)}%</span>}
      </div>
      {dup && <ErrorBox message={`Terindikasi duplikat dengan ${dup.number} (${idr(dup.amount)}, ${fmtDateTime(dup.date)}, status ${STATUS_LABEL[dup.status]}). Tinjau sebelum mengajukan.`} />}
      {editable && missing.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Data belum lengkap: {missing.join(", ")}</div>}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Data transaksi" actions={editable && user.can("finance.create") && (
            <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah transaksi" wide>
              <TxForm mode="edit" action={updateTx} banks={banks} categories={categories} stores={stores} init={{ id: t.id, direction: t.direction, amount: Number(t.amount), date: dateStr(new Date(Date.UTC(p.year, p.month - 1, p.day))), time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, storeId: t.storeId, counterparty: t.counterparty, note: t.note }} />
            </Modal>
          )}>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Jenis</dt><dd>{t.direction}</dd>
                <dt className="text-slate-500">Rekening</dt><dd>{banks.find((b) => b.id === t.accountId)?.name}{t.toAccountId && ` → ${banks.find((b) => b.id === t.toAccountId)?.name}`}</dd>
                <dt className="text-slate-500">Kategori</dt><dd>{categories.find((c) => c.id === t.categoryId)?.name ?? "—"}</dd>
                <dt className="text-slate-500">Pihak terkait</dt><dd>{t.counterparty ?? "—"}</dd>
                <dt className="text-slate-500">Catatan</dt><dd>{t.note ?? "—"}</dd>
              </dl>
          </Card>
          {t.rawText && <Card title="Pesan asli"><p className="whitespace-pre-wrap text-sm text-slate-600">{t.rawText}</p></Card>}
          {journal && (
            <Card title={`Jurnal ${journal.number}`}>
              <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th>Akun</th><th className="text-right">Debit</th><th className="text-right">Kredit</th></tr></thead>
                <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} {l.account.name}</td><td className="text-right tabular-nums">{Number(l.debit) ? idr(l.debit) : ""}</td><td className="text-right tabular-nums">{Number(l.credit) ? idr(l.credit) : ""}</td></tr>)}</tbody>
              </table>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          {t.proofPath && (
            <Card title="Bukti (privat)">
              {t.proofMime === "application/pdf" ? <a className="link text-sm" href={`/api/files/proof/${t.id}`} target="_blank">Buka PDF bukti</a> : (
                // eslint-disable-next-line @next/next/no-img-element
                <a href={`/api/files/proof/${t.id}`} target="_blank"><img src={`/api/files/proof/${t.id}`} alt="Bukti transaksi" className="max-h-80 w-full rounded-lg object-contain" /></a>
              )}
            </Card>
          )}
          {editable && (
            <Card title="Tindakan">
              <div className="space-y-3">
                {(t.status === "DRAFT" || t.status === "PERLU_DITINJAU") && (user.can("finance.create") || user.can("finance.review")) && (
                  <ActionForm action={submitTx}><input type="hidden" name="id" value={t.id} /><Submit className="btn-primary w-full">{t.status === "DRAFT" ? "Ajukan konfirmasi" : "Selesai ditinjau → ajukan"}</Submit></ActionForm>
                )}
                {t.status === "MENUNGGU_KONFIRMASI" && user.can("finance.approve") && (
                  <ActionForm action={approveTx} confirm={`Setujui & bukukan ${idr(t.amount)}? Jurnal tidak dapat diubah setelah dibukukan.`}><input type="hidden" name="id" value={t.id} /><Submit className="btn-success w-full" pendingText="Membukukan…">✓ Setujui & bukukan</Submit></ActionForm>
                )}
                {t.status === "MENUNGGU_KONFIRMASI" && !user.can("finance.approve") && <p className="text-sm text-slate-500">Menunggu persetujuan pihak berwenang (Owner/Finance).</p>}
                {(user.can("finance.review") || user.can("finance.approve")) && (
                  <Modal trigger="Tolak" triggerClass="btn-danger w-full" title="Tolak transaksi">
                    <ModalForm action={rejectTx} className="space-y-3"><input type="hidden" name="id" value={t.id} /><Field label="Alasan penolakan"><input name="reason" className="input" required /></Field><Submit className="btn-danger">Tolak transaksi</Submit></ModalForm>
                  </Modal>
                )}
              </div>
            </Card>
          )}
          <Card title="Jejak persetujuan">
            <ol className="space-y-3 text-sm">
              {t.approvals.map((a) => (
                <li key={a.id} className="border-l-2 border-brand-200 pl-3">
                  <div className="font-medium">{a.action.replace(/_/g, " ")}</div>
                  <div className="text-xs text-slate-500">{fmtDateTime(a.at)} · {a.actorName}{a.viaTelegramId && ` (Telegram ${a.viaTelegramId})`}</div>
                  <div className="text-xs">{a.fromStatus && `${STATUS_LABEL[a.fromStatus]} → `}{STATUS_LABEL[a.toStatus]}</div>
                  {a.note && <div className="text-xs text-slate-600">{a.note}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
