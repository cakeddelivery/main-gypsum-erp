import { payableOptions } from "@/lib/payables";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { dateStr, fmtDate, fmtDateTime, jakartaParts, nowTimeStr, todayStr } from "@/lib/time";
import { describeParts, parseLink, reserveOptions } from "@/lib/reserveSync";
import { walletForMarketplace } from "@/lib/extract";
import Link from "next/link";
import { STATUS_LABEL, WD_RECEIVED_SOURCE, missingFields, splitIssues } from "@/lib/finance";
import { MIRROR_SOURCES, originHref, originLabel } from "@/lib/txMirror";
import { Badge, Card, ErrorBox, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProofPreview } from "@/components/ProofPreview";
import { TxForm } from "../TxForm";
import { isTiktokSeller, canReceive } from "@/lib/wdProcess";
import { WdReceiveFields } from "@/components/WdReceive";
import { attachProofTx, receiveWdTx, linkReserveTx, setReserveTx, approveTx, cancelTx, changeAccountTx, changeStoreTx, deleteTx, reclassifyTx, rejectTx, restoreTx, submitTx, updateTx } from "../actions";

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
  // WD TikTok: jurnal ke-2 "uang diterima" (Dana dalam Perjalanan → rekening bank)
  const receivedJournals = t.sentAt ? await prisma.journal.findMany({ where: { source: WD_RECEIVED_SOURCE, sourceId: t.id }, include: { lines: { include: { account: true } } }, orderBy: { date: "asc" } }) : [];
  const payable = t.payableId ? await prisma.payable.findUnique({ where: { id: t.payableId } }) : null;
  const own = !t.origin;
  const reclassable = own && t.status === "DIBUKUKAN" && t.direction !== "TRANSFER" && !t.splits.length && user.can("finance.approve");
  const openPay = reclassable && t.direction === "KELUAR" ? (await prisma.payable.findMany({ orderBy: { date: "desc" }, include: { supplier: { select: { name: true } } } })).filter((x) => x.paid < x.amount || x.id === t.payableId) : [];
  const editable = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status);
  const missing = [...missingFields(t), ...splitIssues(t.amount, t.direction, t.splits)];
  const p = jakartaParts(t.date);
  const suggested = categories.find((c) => c.id === t.suggestedCategoryId);
  const ai = t.aiExtraction as { confidence?: number; missing?: string[] } | null;
  // Dana sisihan: transfer ke rekening simpanan dana (kompensasi owner / tabungan cicilan)
  const isTransfer = t.direction === "TRANSFER" && !!t.accountId && !!t.toAccountId;
  const linked = isTransfer ? await prisma.reserveEntry.findMany({ where: { transactionId: t.id }, include: { fund: true }, orderBy: [{ date: "asc" }] }) : [];
  const link = parseLink(t.reserveLink);
  const fromBank = banks.find((b) => b.id === t.accountId);
  const toBank = banks.find((b) => b.id === t.toAccountId);
  // Transfer bank → saldo penjual (tidak mungkin): tawarkan rekening dompet digital platform yang sama
  const fixTo = isTransfer && fromBank && toBank && !fromBank.marketplace ? walletForMarketplace(toBank, banks) : null;
  const canLink = own && isTransfer && !linked.length && (editable || (t.status === "DIBUKUKAN" && user.can("finance.approve")));
  const rsv = canLink ? await reserveOptions(prisma, { amount: Number(t.amount), fromBankId: t.accountId, toBankId: fixTo?.id ?? t.toAccountId, date: todayStr(t.date), text: [t.note, t.rawText, t.counterparty].filter(Boolean).join(" "), excludeTxId: t.id }) : null;
  const chosen = link && "parts" in link ? await describeParts(prisma, link.parts) : [];
  // Withdraw TikTok: dikonfirmasi → Dalam Proses (tanpa jurnal) sampai uangnya diterima di rekening
  const tiktokWd = t.direction === "TRANSFER" && isTiktokSeller(fromBank);
  const mayReceive = t.status === "DALAM_PROSES" && (user.can("finance.approve") || user.can("finance.create")) && (await canReceive(t.id, { id: user.id, canApprove: user.can("finance.approve") }));
  return (
    <div className="space-y-5">
      <PageHeader title={`Transaksi ${t.number}`} subtitle={`${idr(t.amount)} · ${fmtDateTime(t.date)} · dibuat ${t.createdBy}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={t.status === "DIBUKUKAN" ? "green" : t.status === "DITOLAK" || t.status === "DIBATALKAN" ? "red" : t.status === "MENUNGGU_KONFIRMASI" || t.status === "DALAM_PROSES" ? "blue" : "amber"}>{STATUS_LABEL[t.status]}</Badge>
        <Badge>{t.source}</Badge>
        {t.store && t.direction === "TRANSFER" && <Badge tone="purple">{t.store.name}</Badge>}
        {suggested && <span className="text-xs text-slate-500">Rekomendasi kategori: <b>{suggested.name}</b></span>}
        {ai?.confidence !== undefined && <span className="text-xs text-slate-500">Keyakinan ekstraksi {Math.round(ai.confidence * 100)}%</span>}
      </div>
      {t.origin && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-800">
          Baris ini tertaut dari <b>{originLabel(t.origin, t.direction)}</b>{t.originRef ? ` (${t.originRef})` : ""}: uang rekening yang dibukukan di menu tersebut. Jurnalnya satu (jurnal menu sumber), jadi saldo tidak terhitung dua kali. Ubah atau batalkan di menu sumbernya; baris ini ikut menyesuaikan.{" "}
          <Link className="link" href={originHref(t.origin, t.originRef) ?? "/finance"}>Buka menu {MIRROR_SOURCES[t.origin].label} ›</Link>
        </div>
      )}
      {dup && <ErrorBox message={`Terindikasi duplikat dengan ${dup.number} (${idr(dup.amount)}, ${fmtDateTime(dup.date)}, status ${STATUS_LABEL[dup.status]}). Tinjau sebelum mengajukan.`} />}
      {editable && missing.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Data belum lengkap: {missing.join(", ")}</div>}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Data transaksi" actions={editable && user.can("finance.create") && (
            <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah transaksi" wide>
              <TxForm mode="edit" action={updateTx} banks={banks} categories={categories} stores={stores} defaultStoreId={def?.value} payables={await payableOptions(t.payableId)} init={{ id: t.id, direction: t.direction, amount: Number(t.amount), date: dateStr(new Date(Date.UTC(p.year, p.month - 1, p.day))), time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, payableId: t.payableId, storeId: t.storeId, counterparty: t.counterparty, note: t.note, splits: t.splits.map((x) => ({ categoryId: x.categoryId, amount: Number(x.amount), note: x.note ?? "", itemId: x.itemId, itemName: splitItems.find((i) => i.id === x.itemId)?.name ?? null, qty: x.qty ? Number(x.qty) : null })) }} />
            </Modal>
          )}>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Jenis</dt><dd>{t.direction}</dd>
                <dt className="text-slate-500">Rekening</dt><dd>{banks.find((b) => b.id === t.accountId)?.name}{t.toAccountId && ` → ${banks.find((b) => b.id === t.toAccountId)?.name}`}</dd>
                {t.direction === "TRANSFER" && banks.find((b) => b.id === t.accountId)?.marketplace && <><dt className="text-slate-500">Pemasukan</dt><dd className="text-emerald-700">Penjualan {t.store?.name ?? "(toko belum dipilih)"} {idr(t.amount)} · dari withdraw saldo penjual</dd></>}
                <dt className="text-slate-500">Kategori</dt><dd>{payable ? <>{payable.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang"} <b>{payable.number}</b> {payable.vendor}<div className="text-xs text-slate-500">Pokok {idr(Number(t.amount - t.payInterest))}{t.payInterest > BigInt(0) ? ` · bunga/biaya ${idr(t.payInterest)}` : ""} · sisa hutang {idr(payable.amount - payable.paid)}</div></> : t.splits.length ? `${t.splits.length} rincian` : categories.find((c) => c.id === t.categoryId)?.name ?? "—"}</dd>
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
          {[journal, ...receivedJournals].filter((j): j is NonNullable<typeof journal> => !!j).map((j, k) => (
            <Card key={j.id} title={`Jurnal ${j.number}${t.sentAt ? (k === 0 ? " · ditransfer" : ` · uang diterima ${fmtDateTime(j.date)}`) : ""}`}>
              <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th>Akun</th><th className="text-right">Debit</th><th className="text-right">Kredit</th></tr></thead>
                <tbody>{j.lines.map((l) => <tr key={l.id}><td>{l.account.code} {l.account.name}</td><td className="text-right tabular-nums">{Number(l.debit) ? idr(l.debit) : ""}</td><td className="text-right tabular-nums">{Number(l.credit) ? idr(l.credit) : ""}</td></tr>)}</tbody>
              </table>
            </Card>
          ))}
        </div>
        <div className="space-y-5">
          {(t.proofPath || user.can("finance.create")) && (
            <Card title="Bukti (privat)">
              {t.proofPath ? <ProofPreview thumb src={`/api/files/proof/${t.id}`} mime={t.proofMime} title={`Bukti ${t.number}`} /> : <p className="mb-2 text-sm text-amber-700">Belum ada bukti transfer.</p>}
              {user.can("finance.create") && (!t.proofPath || user.can("finance.approve")) && t.status !== "DITOLAK" && t.status !== "DIBATALKAN" && (
                <Modal trigger={t.proofPath ? "Ganti bukti" : "+ Lampirkan bukti"} triggerClass="btn-secondary btn-sm mt-2" title={`Bukti ${t.number}`}>
                  <ModalForm action={attachProofTx} className="space-y-3">
                    <input type="hidden" name="id" value={t.id} />
                    <Field label="Foto / PDF bukti" hint="JPG/PNG/PDF, maks 5 MB. Ikut terlampir di dana sisihan yang tersambung. Jurnal tidak berubah."><input type="file" name="proof" required accept="image/jpeg,image/png,image/webp,application/pdf" className="input py-1.5" /></Field>
                    <Submit>Lampirkan</Submit>
                  </ModalForm>
                </Modal>
              )}
            </Card>
          )}
          {linked.length > 0 && (
            <Card title="Dana sisihan" actions={<Link className="link text-sm" href="/finance/sisihan">Buka ›</Link>}>
              <ul className="space-y-1 text-sm">{linked.map((e) => <li key={e.id} className="flex justify-between gap-2"><span>{e.fund.name} · {fmtDate(e.date)}</span><span className="tabular-nums">{idr(e.amount)}</span></li>)}</ul>
              <p className="mt-2 text-xs text-slate-500">Tercatat dari transfer ini, bukti transfer ikut terlampir.</p>
            </Card>
          )}
          {canLink && (rsv || chosen.length > 0 || link) && (
            <Card title="Dana sisihan">
              {editable ? (
                <>
                  <p className="mb-2 text-sm">
                    {link && "skip" in link ? "Dicatat sebagai transfer biasa (bukan sisihan)." : chosen.length ? <>Saat dibukukan, dicatat sebagai sisihan <b>{chosen.map((c) => `${c.fund.name} (${c.dates.map((d) => d.slice(8)).join(",")})`).join(" + ")}</b>.</> : rsv?.sure ? <>Saat dibukukan, otomatis dicatat sebagai sisihan <b>{rsv.options[0].label}</b> ({rsv.options[0].dates.map((d) => d.slice(8)).join(",")}).</> : rsv ? "Nominal cocok dengan beberapa dana sisihan. Pilih salah satu agar ikut tercatat saat dibukukan." : "Tidak ada dana sisihan yang cocok."}
                  </p>
                  {fixTo && <p className="mb-2 text-xs text-amber-700">Rekening tujuan {toBank?.name} tidak bisa menerima transfer dari bank. Mungkin maksudnya {fixTo.name}: ubah rekening tujuan dulu.</p>}
                  {user.can("finance.create") && (
                    <ActionForm action={setReserveTx} className="space-y-2">
                      <input type="hidden" name="id" value={t.id} />
                      <select name="pick" className="input" defaultValue={link && "skip" in link ? "skip" : "auto"}>
                        <option value="auto">Otomatis (dicocokkan saat dibukukan)</option>
                        {!fixTo && rsv?.options.map((o, k) => <option key={k} value={String(k)}>{o.label} ({o.dates.map((d) => d.slice(8)).join(",")})</option>)}
                        <option value="skip">Bukan sisihan (transfer biasa)</option>
                      </select>
                      <Submit className="btn-secondary btn-sm">Simpan pilihan</Submit>
                    </ActionForm>
                  )}
                </>
              ) : rsv ? (
                <>
                  <p className="mb-2 text-sm">Transfer ini cocok dengan dana sisihan tapi belum tercatat di sana{fixTo ? <> (rekening tujuan kemungkinan <b>{fixTo.name}</b>, bukan {toBank?.name})</> : ""}.</p>
                  <ActionForm action={linkReserveTx} className="space-y-2" confirm="Sinkronkan transfer ini ke dana sisihan? Jurnalnya dibukukan ulang.">
                    <input type="hidden" name="id" value={t.id} />
                    {fixTo && <input type="hidden" name="toAccountId" value={fixTo.id} />}
                    <select name="pick" className="input" defaultValue="0">{rsv.options.map((o, k) => <option key={k} value={String(k)}>{o.label} ({o.dates.map((d) => d.slice(8)).join(",")})</option>)}</select>
                    <p className="text-xs text-slate-500">Jurnal lama dibalik lalu dibukukan ulang{fixTo ? ` ke ${fixTo.name}` : ""}{" "}beserta beban kompensasi (untuk dana owner). Sisihan tanpa bukti di tanggal tsb memakai transfer ini, jadi tidak dobel.</p>
                    <Submit className="btn-secondary btn-sm" pendingText="Menyinkronkan…">Sinkronkan ke dana sisihan</Submit>
                  </ActionForm>
                </>
              ) : null}
            </Card>
          )}
          {editable && (
            <Card title="Tindakan">
              <div className="space-y-3">
                {(t.status === "DRAFT" || t.status === "PERLU_DITINJAU") && (user.can("finance.create") || user.can("finance.review")) && (
                  <ActionForm action={submitTx}><input type="hidden" name="id" value={t.id} /><Submit className="btn-primary w-full">{t.status === "DRAFT" ? "Ajukan konfirmasi" : "Selesai ditinjau → ajukan"}</Submit></ActionForm>
                )}
                {t.status === "MENUNGGU_KONFIRMASI" && user.can("finance.approve") && (tiktokWd ? (
                  <>
                    <p className="text-xs text-slate-500">Withdraw TikTok baru masuk bank 1–3 hari setelah ditransfer. Setelah dikonfirmasi statusnya <b>Dalam Proses</b>: penjualan diakui dan uangnya dicatat di Dana dalam Perjalanan (saldo bank belum bertambah) sampai Anda menekan <b>Uang diterima</b>.</p>
                    <ActionForm action={approveTx} confirm={`Konfirmasi withdraw ${idr(t.amount)}? Statusnya menjadi Dalam Proses sampai uangnya diterima.`}><input type="hidden" name="id" value={t.id} /><Submit className="btn-success w-full" pendingText="Menyimpan…">✓ Konfirmasi (dalam proses)</Submit></ActionForm>
                  </>
                ) : (
                  <ActionForm action={approveTx} confirm={`Setujui & bukukan ${idr(t.amount)}? Jurnal tidak dapat diubah setelah dibukukan.`}><input type="hidden" name="id" value={t.id} /><Submit className="btn-success w-full" pendingText="Membukukan…">✓ Setujui & bukukan</Submit></ActionForm>
                ))}
                {t.status === "MENUNGGU_KONFIRMASI" && !user.can("finance.approve") && <p className="text-sm text-slate-500">Menunggu persetujuan pihak berwenang (Owner/Finance).</p>}
                {(user.can("finance.review") || user.can("finance.approve")) && (
                  <Modal trigger="Tolak" triggerClass="btn-danger w-full" title="Tolak transaksi">
                    <ModalForm action={rejectTx} className="space-y-3"><input type="hidden" name="id" value={t.id} /><Field label="Alasan penolakan"><input name="reason" className="input" required /></Field><Submit className="btn-danger">Tolak transaksi</Submit></ModalForm>
                  </Modal>
                )}
              </div>
            </Card>
          )}
          {t.status === "DALAM_PROSES" && (
            <Card title="⏳ Dalam proses">
              <div className="space-y-3">
                <p className="text-sm text-slate-600">Withdraw sudah ditransfer{t.sentAt ? ` (${fmtDateTime(t.sentAt)})` : ""} tetapi uangnya belum masuk {toBank?.name ?? "rekening"}. Penjualan sudah diakui; uangnya dicatat di akun <b>Dana dalam Perjalanan</b>, jadi saldo {toBank?.name ?? "rekening"} belum bertambah.</p>
                {mayReceive ? (
                  <Modal trigger="💰 Uang diterima" triggerClass="btn-success w-full" title={`Uang diterima · ${t.number}`}>
                    <ModalForm action={receiveWdTx} className="space-y-3">
                      <p className="text-sm text-slate-600">{idr(t.amount)} dibukukan dengan tanggal & jam uang masuk di rekening (lihat riwayat bank).</p>
                      <WdReceiveFields id={t.id} toAccountId={t.toAccountId} banks={banks.filter((b) => !b.marketplace).map((b) => ({ id: b.id, name: b.name }))} date={todayStr()} time={nowTimeStr()} />
                      <Submit className="btn-success" pendingText="Membukukan…">Simpan: uang diterima</Submit>
                    </ModalForm>
                  </Modal>
                ) : <p className="text-sm text-slate-500">Hanya Owner/Finance atau pembuat transaksi yang dapat menandai uang diterima.</p>}
              </div>
            </Card>
          )}
          {own && (t.status === "DIBUKUKAN" || t.status === "DALAM_PROSES") && t.direction === "TRANSFER" && user.can("finance.approve") && stores.length > 1 && (
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
          {own && t.status === "DIBUKUKAN" && t.direction !== "TRANSFER" && user.can("finance.approve") && (
            <Card title="Ubah rekening">
              <p className="mb-3 text-xs text-slate-500">Salah pilih rekening? Jurnal lama dibalik lalu dibukukan ulang dari rekening yang benar. Saldo kedua rekening ikut menyesuaikan.</p>
              <Modal trigger="Ubah rekening" triggerClass="btn-secondary w-full" title="Ubah rekening transaksi dibukukan">
                <ModalForm action={changeAccountTx} className="space-y-3">
                  <input type="hidden" name="id" value={t.id} />
                  <p className="text-sm text-slate-600">{t.number} · {idr(t.amount)} · {t.note ?? t.counterparty ?? ""}</p>
                  <Field label="Rekening"><select name="accountId" defaultValue={t.accountId ?? ""} className="input" required>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Submit pendingText="Menyimpan…">Simpan rekening</Submit>
                </ModalForm>
              </Modal>
            </Card>
          )}
          {reclassable && (
            <Card title="Ubah kategori">
              <p className="mb-3 text-xs text-slate-500">Salah kategori, atau ternyata bayar hutang / cicilan pinjaman? Jurnal lama dibalik lalu dibukukan ulang. Saldo rekening tidak berubah.</p>
              <Modal trigger="Ubah kategori" triggerClass="btn-secondary w-full" title="Ubah kategori transaksi dibukukan">
                <ModalForm action={reclassifyTx} className="space-y-3">
                  <input type="hidden" name="id" value={t.id} />
                  <p className="text-sm text-slate-600">{t.number} · {idr(t.amount)} · {t.note ?? t.counterparty ?? ""}</p>
                  <Field label="Dicatat sebagai">
                    <select name="target" defaultValue={t.payableId ? `pay:${t.payableId}` : t.categoryId ? `cat:${t.categoryId}` : ""} className="input" required>
                      <option value="" disabled>— pilih —</option>
                      {openPay.length > 0 && <optgroup label="Bayar hutang / cicilan pinjaman">{openPay.map((x) => <option key={x.id} value={`pay:${x.id}`}>{x.kind === "PINJAMAN" ? "Pinjaman" : "Hutang"} {x.number} · {x.supplier?.name ?? x.vendor} · sisa {idr(x.amount - x.paid)}</option>)}</optgroup>}
                      <optgroup label="Kategori">{categories.filter((c) => c.direction === t.direction).map((c) => <option key={c.id} value={`cat:${c.id}`}>{c.name}</option>)}</optgroup>
                    </select>
                  </Field>
                  {t.direction === "KELUAR" && <Field label="Bunga / biaya (khusus bayar pinjaman)" hint="Kosong = otomatis dari jadwal cicilan bila nominalnya sama; sisanya mengurangi pokok hutang"><input name="interest" inputMode="numeric" className="input" placeholder="otomatis" /></Field>}
                  <Submit pendingText="Menyimpan…">Simpan</Submit>
                </ModalForm>
              </Modal>
            </Card>
          )}
          {own && (t.status === "DIBUKUKAN" || t.status === "DALAM_PROSES") && user.can("finance.approve") && (
            <Card title="Batalkan transaksi">
              <p className="mb-3 text-xs text-slate-500">Salah catat atau transaksi uji coba? Pembatalan membuat jurnal pembalik sehingga saldo rekening & laba rugi kembali seperti semula{t.sentAt ? " (withdraw TikTok: jurnal transfer & jurnal uang diterima, bila ada, ikut dibalik)" : ""}. Riwayatnya tetap tersimpan.</p>
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
                <>
                  <p className="mb-3 text-sm text-slate-500">Disembunyikan dari daftar oleh {t.deletedBy} · {fmtDateTime(t.deletedAt)}</p>
                  <ActionForm action={restoreTx} confirm={`Tampilkan lagi ${t.number} di daftar Transaksi?`}>
                    <input type="hidden" name="id" value={t.id} />
                    <Submit className="btn-secondary w-full" pendingText="Memproses…">Tampilkan lagi di daftar</Submit>
                  </ActionForm>
                </>
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
