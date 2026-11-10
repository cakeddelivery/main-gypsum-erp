import { payableOptions } from "@/lib/payables";
import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime, jakartaDateTime, todayStr } from "@/lib/time";
import { STATUS_LABEL } from "@/lib/finance";
import { originLabel } from "@/lib/txMirror";
import { Badge, Empty, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import type { Prisma, TxStatus } from "@prisma/client";
import { TxForm } from "./TxForm";
import { createTx, deleteAllClosedTx, extractAction, restoreTx } from "./actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";

export const metadata = { title: "Transaksi" };
const STATUSES: TxStatus[] = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI", "DALAM_PROSES", "DIBUKUKAN", "DITOLAK", "DIBATALKAN"];
const TONE: Record<TxStatus, "gray" | "amber" | "blue" | "green" | "red"> = { DRAFT: "gray", PERLU_DITINJAU: "amber", MENUNGGU_KONFIRMASI: "blue", DALAM_PROSES: "blue", DIBUKUKAN: "green", DITOLAK: "red", DIBATALKAN: "red" };
const SOURCE = { MANUAL: "Manual", TELEGRAM: "Telegram", AI: "AI/Hermes" };
const srcLabel = (t: { source: keyof typeof SOURCE; origin: string | null; direction: string }) => (t.origin ? (originLabel(t.origin, t.direction) ?? "") : SOURCE[t.source]);

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePerm("finance.view");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as TxStatus) ? (sp.status as TxStatus) : undefined;
  const sellerIds = sp.direction === "WD" ? (await prisma.bankAccount.findMany({ where: { marketplace: true }, select: { id: true } })).map((b) => b.id) : [];
  // ?sembunyi=1 → hanya transaksi Dibatalkan/Ditolak yang pernah disembunyikan dari daftar
  const hidden = sp.sembunyi === "1";
  const where: Prisma.FinanceTransactionWhereInput = {
    deletedAt: hidden ? { not: null } : null,
    // Sumber: Manual/Telegram/AI = transaksi menu ini; "LAIN" = baris tertaut dari menu lain (pembelian, gaji, ...)
    ...(sp.source === "LAIN" ? { origin: { not: null } } : sp.source ? { source: sp.source as never, origin: null } : {}),
    ...(sp.direction === "WD" ? { direction: "TRANSFER" as const, accountId: { in: sellerIds } } : sp.direction ? { direction: sp.direction as never } : {}),

    ...(sp.store ? { storeId: sp.store } : {}),
    ...(sp.from || sp.to ? { date: { ...(sp.from ? { gte: jakartaDateTime(sp.from, "00:00") } : {}), ...(sp.to ? { lt: new Date(jakartaDateTime(sp.to, "00:00").getTime() + 86400000) } : {}) } } : {}),
    // Filter rekening & kata kunci sama-sama OR, jadi digabung dengan AND agar tidak saling menimpa
    AND: [
      ...(sp.account ? [{ OR: [{ accountId: sp.account }, { toAccountId: sp.account }] }] : []),
      ...(sp.q ? [{ OR: [{ number: { contains: sp.q, mode: "insensitive" as const } }, { note: { contains: sp.q, mode: "insensitive" as const } }, { counterparty: { contains: sp.q, mode: "insensitive" as const } }] }] : []),
    ],
  };
  const [rows, counts, banks, cats, stores, def, hiddenCount] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { ...where, ...(status ? { status } : {}) }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200, include: { payable: { select: { number: true, kind: true, vendor: true } } } }),
    prisma.financeTransaction.groupBy({ by: ["status"], where, _count: true }),
    prisma.bankAccount.findMany(),
    prisma.txCategory.findMany(),
    prisma.store.findMany({ orderBy: { code: "asc" } }),
    prisma.setting.findUnique({ where: { key: "default_store_id" } }),
    status === "DIBATALKAN" || status === "DITOLAK" ? prisma.financeTransaction.count({ where: { status, deletedAt: { not: null } } }) : 0,
  ]);
  const name = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name ?? "—";
  // Withdraw saldo penjual marketplace = pemasukan penjualan toko (MG / DL)
  const isWd = (t: { direction: string; accountId: string | null }) => t.direction === "TRANSFER" && !!banks.find((b) => b.id === t.accountId)?.marketplace;
  type PayRef = { payable: { number: string; kind: string; vendor: string } | null; categoryId: string | null };
  const catLabel = (t: PayRef & { origin?: string | null; direction?: string }) => (t.origin ? (originLabel(t.origin, t.direction) ?? "—") : t.payable ? `${t.payable.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang"} · ${t.payable.vendor}` : name(cats, t.categoryId));
  const wdLabel = (t: { storeId: string | null }) => `Pemasukan penjualan · ${stores.find((x) => x.id === t.storeId)?.code ?? "toko?"}`;
  const qs = (s?: string) => { const u = new URLSearchParams(Object.entries({ ...sp, baru: undefined, sembunyi: undefined, status: s }).filter(([, v]) => v) as [string, string][]); return `/finance?${u}`; };
  return (
    <div>
      <PageHeader title="Transaksi" subtitle="Pemasukan, pengeluaran & transfer dari input manual, Telegram, dan AI · IDR · WIB" actions={<><DownloadCsv filename={`transaksi-${todayStr()}`} rows={[["Nomor", "Tanggal", "Arah", "Jumlah (Rp)", "Rekening", "Ke rekening", "Kategori", "Toko", "Pihak", "Catatan", "Status"], ...rows.map((t) => [t.number, fmtDateTime(t.date), t.direction, Number(t.amount), name(banks, t.accountId), t.toAccountId ? name(banks, t.toAccountId) : "", catLabel(t), t.storeId ? name(stores, t.storeId) : "", t.counterparty ?? "", t.note ?? "", STATUS_LABEL[t.status]])]} />{user.can("finance.approve") && <Link href="/finance/sisihan" className="btn-secondary">Dana sisihan</Link>}{user.can("finance.approve") && <Link href="/finance/talangan" className="btn-secondary">Dana talangan</Link>}{user.can("finance.approve") && <Link href="/finance/cek-saldo" className="btn-secondary">Cek saldo harian</Link>}{(user.can("finance.approve") || user.can("accounting.view")) && <Link href="/finance/mutasi" className="btn-secondary">Mutasi rekening</Link>}{user.can("accounting.post") && <Link href="/akuntansi/saldo-rekening" className="btn-secondary">Atur saldo rekening</Link>}{user.can("finance.create") && (
        <Modal trigger="+ Transaksi" title="Transaksi baru" wide defaultOpen={sp.baru === "1"}>
          <p className="mb-3 text-xs text-slate-500">Masuk ke daftar Transaksi sebagai draft — baru dibukukan setelah disetujui pihak berwenang.</p>
          <TxForm mode="create" action={createTx} extract={extractAction} banks={banks.filter((b) => b.active)} categories={cats.filter((c) => c.active)} stores={stores.filter((x) => x.active)} defaultStoreId={def?.value} payables={user.can("finance.create") ? await payableOptions() : []} init={{ direction: "KELUAR", date: todayStr(), storeId: def?.value ?? stores[0]?.id }} />
        </Modal>
      )}</>} />
      <Tabs current={status ?? "ALL"} tabs={[{ key: "ALL", label: "Semua", href: qs(undefined), count: counts.reduce((s, c) => s + c._count, 0) }, ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], href: qs(s), count: counts.find((c) => c.status === s)?._count ?? 0 }))]} />
      {(status === "DIBATALKAN" || status === "DITOLAK") && (hidden || hiddenCount > 0) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>{hidden ? `Menampilkan ${hiddenCount} transaksi ${STATUS_LABEL[status].toLowerCase()} yang disembunyikan dari daftar.` : `${hiddenCount} transaksi ${STATUS_LABEL[status].toLowerCase()} disembunyikan dari daftar.`}</span>
          <span className="flex flex-wrap gap-2">
            {hidden && user.can("finance.approve") && hiddenCount > 0 && (
              <ActionForm action={restoreTx} confirm={`Tampilkan lagi semua transaksi ${STATUS_LABEL[status].toLowerCase()} yang disembunyikan?`}>
                <input type="hidden" name="status" value={status} />
                <Submit className="btn-secondary btn-sm" pendingText="Memproses…">Tampilkan lagi semua di daftar</Submit>
              </ActionForm>
            )}
            <Link href={hidden ? qs(status) : `${qs(status)}&sembunyi=1`} className="btn-secondary btn-sm">{hidden ? "← Kembali ke daftar" : "Tampilkan yang disembunyikan"}</Link>
          </span>
        </div>
      )}
      {!hidden && (status === "DIBATALKAN" || status === "DITOLAK") && user.can("finance.approve") && (counts.find((c) => c.status === status)?._count ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <span>Transaksi {STATUS_LABEL[status].toLowerCase()} tidak memengaruhi saldo. Hapus dari daftar agar tidak mengganggu; riwayat & jurnalnya tetap tersimpan untuk audit.</span>
          <ActionForm action={deleteAllClosedTx} confirm={`Hapus semua transaksi ${STATUS_LABEL[status].toLowerCase()} dari daftar?`}>
            <input type="hidden" name="status" value={status} />
            <Submit className="btn-danger btn-sm" pendingText="Menghapus…">Hapus semua yang {STATUS_LABEL[status].toLowerCase()}</Submit>
          </ActionForm>
        </div>
      )}
      <FilterBar>
        {status && <input type="hidden" name="status" value={status} />}
        {hidden && <input type="hidden" name="sembunyi" value="1" />}
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="No. / catatan / pihak" /></Field>
        <Field label="Sumber"><select name="source" defaultValue={sp.source ?? ""} className="input"><option value="">Semua</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="LAIN">Menu lain (pembelian, gaji, …)</option></select></Field>
        <Field label="Jenis"><select name="direction" defaultValue={sp.direction ?? ""} className="input"><option value="">Semua</option><option value="MASUK">Masuk</option><option value="KELUAR">Keluar</option><option value="TRANSFER">Transfer</option><option value="WD">Withdraw (pemasukan)</option></select></Field>
        <Field label="Rekening"><select name="account" defaultValue={sp.account ?? ""} className="input"><option value="">Semua</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Toko (withdraw)"><select name="store" defaultValue={sp.store ?? ""} className="input"><option value="">Semua</option>{stores.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Dari"><input type="date" name="from" defaultValue={sp.from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="to" defaultValue={sp.to} className="input" /></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title="Tidak ada transaksi" hint="Transaksi baru dari web, Telegram, atau Hermes akan muncul di sini." /> : (
        <>
          <ul className="space-y-2 md:hidden">
            {rows.map((t) => (
              <li key={t.id}>
                <Link href={`/finance/${t.id}`} className="card block p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div><div className="text-xs text-slate-400">{t.number} · {srcLabel(t)}</div><div className="text-sm font-medium">{t.note || catLabel(t)}</div>{isWd(t) && <div className="text-xs text-emerald-700">Withdraw · {wdLabel(t)}</div>}</div>
                    <div className={`text-right font-semibold tabular-nums ${t.direction === "MASUK" || isWd(t) ? "text-emerald-600" : t.direction === "KELUAR" ? "text-rose-600" : "text-slate-700"}`}>{t.direction === "KELUAR" ? "−" : t.direction === "MASUK" || isWd(t) ? "+" : "⇄"}{idr(t.amount)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{fmtDateTime(t.date)} · {name(banks, t.accountId)}</span><span className="flex gap-1">{t.deletedAt && <Badge tone="gray">Disembunyikan</Badge>}<Badge tone={TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></span></div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="table-wrap hidden md:block">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Jenis</th><th className="num">Nominal</th><th>Status</th><th>Rekening</th><th>Kategori</th><th>Sumber</th><th>Catatan</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td><Link className="link font-mono text-xs" href={`/finance/${t.id}`}>{t.number}</Link>{t.duplicateOfId && <span title="Terindikasi duplikat" className="ml-1">⚠️</span>}{t.proofPath && <span title="Ada bukti" className="ml-1">📎</span>}</td>
                    <td>{fmtDateTime(t.date)}</td><td>{isWd(t) ? <span className="text-emerald-700">Withdraw</span> : t.direction === "MASUK" ? "Masuk" : t.direction === "KELUAR" ? "Keluar" : "Transfer"}</td>
                    <td className={`num font-medium ${t.direction === "MASUK" || isWd(t) ? "text-emerald-600" : t.direction === "KELUAR" ? "text-rose-600" : ""}`}>{isWd(t) ? "+" : ""}{idr(t.amount)}</td>
                    <td><Badge tone={TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>{t.deletedAt && <> <Badge tone="gray">Disembunyikan</Badge></>}</td>
                    <td>{name(banks, t.accountId)}{t.direction === "TRANSFER" && ` → ${name(banks, t.toAccountId)}`}</td>
                    <td>{isWd(t) ? <span className={t.storeId ? "text-emerald-700" : "text-amber-700"}>{wdLabel(t)}</span> : t.direction === "TRANSFER" ? "—" : catLabel(t)}</td>
                    <td>{srcLabel(t)}</td>
                    <td className="max-w-[180px] truncate">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table></Paged>
          </div>
        </>
      )}
    </div>
  );
}
