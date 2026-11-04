import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { dateStr, fmtDateTime, jakartaParts } from "@/lib/time";
import { STATUS_LABEL, missingFields, splitIssues } from "@/lib/finance";
import { Badge, Card, ErrorBox, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProofPreview } from "@/components/ProofPreview";
import { TxForm } from "../TxForm";
import { approveTx, cancelTx, changeStoreTx, deleteTx, rejectTx, submitTx, updateTx } from "../actions";

export const metadata = { title: "Detail Transaksi" };

export default async function TxDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ dup?: string }> }) {
  const user = await requirePerm("finance.view");
  const { id } = await params;
  const t = await prisma.financeTransaction.findUnique({ where: { id }, include: { approvals: { orderBy: { at: "asc" } }, store: true, splits: { orderBy: { sortOrder: "asc" } } } });
  const splitItems = t ? await prisma.item.findMany({ where: { id: { in: t.splits.map((x) => x.itemId).filter((x): x is string => !!x) } }, select: { id: true, name: true, unit: true } }) : [];
  if (!t) notFound();
  const [banks, categories, stores, dup, journal, def] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.store.findMany({ where: { active: true } }),
    t.duplicateOfId ? prisma.financeTransaction.findUnique({ where: { id: t.duplicateOfId } }) : null,
    t.journalId ? prisma.journal.findUnique({ where: { id: t.journalId }, include: { lines: { include: { account: true } } } }) : null,
    prisma.setting.findUnique({ where: { key: "default_store_id" } }),
  ]);
  const editable = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status);
  const missing = [...missingFields(t), ...splitIssues(t.amount, t.direction, t.splits)];
  const p = jakartaParts(t.date);
  const suggested = categories.find((c) => c.id === t.suggestedCategoryId);
  const ai = t.aiExtraction as { confidence?: number; missing?: string[] } | null;
  return (
    <div className="space-y-5">
      <PageHeader title={`Transaksi ${t.number}`} subtitle={`${idr(t.amount)} · ${fmtDateTime(t.date)} · dibuat ${t.createdBy}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={t.status === "DIBUKUKAN" ? "green" : t.status === "DITOLAK" || t.status === "DIBATALKAN" ? "red" : t.status === "MENUNGGU_KONFIRMASI" ? "blue" : "amber"}>{STATUS_LABEL[t.status]}</Badge>
        <Badge>{t.source}</Badge>
        {t.store && t.direction === "TRANSFER" && <Badge tone="purple">{t.store.name}</Badge>}
        {suggested && <span className="text-xs text-slate-500">Rekomendasi kategori: <b>{suggested.name}</b></span>}
        {ai?.confidence !== undefined && <span className="text-xs text-slate-500">Keyakinan ekstraksi {Math.round(ai.confidence * 100)}%</span>}
      </div>
      {dup && <ErrorBox message={`Terindikasi duplikat dengan ${dup.number} (${idr(dup.amount)}, ${fmtDateTime(dup.date)}, status ${STATUS_LABEL[dup.status]}). Tinjau sebelum mengajukan.`} />}
      {editable && missing.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Data belum lengkap: {missing.join(", ")}</div>}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Data transaksi" actions={editable && user.can("finance.create") && (
            <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah transaksi" wide>
              <TxForm mode="edit" action={updateTx} banks={banks} categories={categories} stores={stores} defaultStoreId={def?.value} init={{ id: t.id, direction: t.direction, amount: Number(t.amount), date: dateStr(new Date(Date.UTC(p.year, p.month - 1, p.day))), time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, storeId: t.storeId, counterparty: t.counterparty, note: t.note, splits: t.splits.map((x) => ({ categoryId: x.categoryId, amount: Number(x.amount), note: x.note ?? "", itemId: x.itemId, itemName: splitItems.find((i) => i.id === x.itemId)?.name ?? null, qty: x.qty ? Number(x.qty) : null })) }} />
            </Modal>
          )}>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Jenis</dt><dd>{t.direction}</dd>
                <dt className="text-slate-500">Rekening</dt><dd>{banks.find((b) => b.id === t.accountId)?.name}{t.toAccountId && ` → ${banks.find((b) => b.id === t.toAccountId)?.name}`}</dd>
                {t.direction === "TRANSFER" && banks.find((b) => b.id === t.accountId)?.marketplace && <><dt className="text-slate-500">Pemasukan</dt><dd className="text-emerald-700">Penjualan {t.store?.name ?? "(toko belum dipilih)"} {idr(t.amount)} · dari withdraw saldo penjual</dd></>}
                <dt className="text-slate-500">Kategori</dt><dd>{t.splits.length ? `${t.splits.length} rincian` : categories.find((c) => c.id === t.categoryId)?.name ?? "—"}</dd>
                <dt className="text-slate-500">Pihak terkait</dt><dd>{t.counterparty ?? "—"}</dd>
                <dt className="text-slate-500">Catatan</dt><dd>{t.note ?? "—"}</dd>
              </dl>
              {t.splits.length > 0 && (
                <table className="mt-4 w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500"><th>Rincian</th><th>Kategori</th><th className="text-right">Nominal</th></tr></thead>
                  <tbody>
                    {t.splits.map((x) => {
                      const it = splitItems.find((i) => i.id === x.itemId);
                      return <tr key={x.id}><td>{x.note ?? "—"}</td><td>{it ? `📦 Stok ${it.name} × ${Number(x.qty)} ${it.unit}` : categories.find((c) => c.id === x.categoryId)?.name ?? <span className="text-rose-600">belum dipilih</span>}</td><td className="text-right tabular-nums">{idr(x.amount)}</td></tr>;
                    })}
                    <tr className="border-t font-semibold"><td colSpan={2}>Total</td><td className="text-right tabular-nums">{idr(t.splits.reduce((a, x) => a + Number(x.amount), 0))}</td></tr>
                  </tbody>
                </table>
              )}
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
              <ProofPreview thumb src={`/api/files/proof/${t.id}`} mime={t.proofMime} title={`Bukti ${t.number}`} />
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
          {t.status === "DIBUKUKAN" && t.direction === "TRANSFER" && user.can("finance.approve") && stores.length > 1 && (
            <Card title="Toko withdraw">
              <p className="mb-3 text-sm">Toko: <b>{t.store?.name ?? "—"}</b></p>
              <Modal trigger="Ganti toko" triggerClass="btn-secondary w-full" title="Ganti toko withdraw">
                <ModalForm action={changeStoreTx} className="space-y-3">
                  <input type="hidden" name="id" value={t.id} />
                  <Field label="Toko (MG / DL)"><select name="storeId" defaultValue={t.storeId ?? ""} className="input">{stores.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></Field>
                  <p className="text-xs text-slate-500">Jurnal lama dibalik lalu dibukukan ulang dengan toko baru. Saldo rekening tidak berubah.</p>
                  <Submit pendingText="Menyimpan…">Simpan toko</Submit>
                </ModalForm>
              </Modal>
            </Card>
          )}
          {t.status === "DIBUKUKAN" && user.can("finance.approve") && (
            <Card title="Batalkan transaksi">
              <p className="mb-3 text-xs text-slate-500">Salah catat atau transaksi uji coba? Pembatalan membuat jurnal pembalik sehingga saldo rekening & laba rugi kembali seperti semula. Riwayatnya tetap tersimpan.</p>
              <Modal trigger="Batalkan transaksi" triggerClass="btn-danger w-full" title="Batalkan transaksi dibukukan">
                <ModalForm action={cancelTx} className="space-y-3">
                  <input type="hidden" name="id" value={t.id} />
                  <p className="text-sm text-slate-600">{t.number} · {idr(t.amount)} · {fmtDateTime(t.date)}</p>
                  <Field label="Alasan pembatalan"><input name="reason" className="input" required placeholder="cth: transaksi uji coba / salah nominal" /></Field>
                  <Submit className="btn-danger" pendingText="Membatalkan…">Batalkan & buat jurnal pembalik</Submit>
                </ModalForm>
              </Modal>
            </Card>
          )}
          {(t.status === "DIBATALKAN" || t.status === "DITOLAK") && user.can("finance.approve") && (
            <Card title="Hapus transaksi">
              {t.deletedAt ? (
                <p className="text-sm text-slate-500">Sudah dihapus dari daftar oleh {t.deletedBy} · {fmtDateTime(t.deletedAt)}</p>
              ) : (
                <>
                  <p className="mb-3 text-xs text-slate-500">Transaksi ini tidak memengaruhi saldo{t.status === "DIBATALKAN" ? " (sudah dinetralkan jurnal pembalik)" : ""}. Menghapus menyembunyikannya dari daftar Transaksi; riwayatnya tetap tersimpan untuk audit.</p>
                  <ActionForm action={deleteTx} confirm={`Hapus ${t.number} dari daftar Transaksi?`}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="back" value="1" />
                    <Submit className="btn-danger w-full" pendingText="Menghapus…">Hapus transaksi</Submit>
                  </ActionForm>
                </>
              )}
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
