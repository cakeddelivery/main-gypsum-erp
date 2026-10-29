import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime, jakartaDateTime } from "@/lib/time";
import { STATUS_LABEL } from "@/lib/finance";
import { Badge, Empty, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import type { Prisma, TxStatus } from "@prisma/client";

export const metadata = { title: "Finance Inbox" };
const STATUSES: TxStatus[] = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI", "DIBUKUKAN", "DITOLAK"];
const TONE: Record<TxStatus, "gray" | "amber" | "blue" | "green" | "red"> = { DRAFT: "gray", PERLU_DITINJAU: "amber", MENUNGGU_KONFIRMASI: "blue", DIBUKUKAN: "green", DITOLAK: "red" };
const SOURCE = { MANUAL: "Manual", TELEGRAM: "Telegram", AI: "AI/Hermes" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePerm("finance.view");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as TxStatus) ? (sp.status as TxStatus) : undefined;
  const where: Prisma.FinanceTransactionWhereInput = {
    ...(sp.source ? { source: sp.source as never } : {}),
    ...(sp.direction ? { direction: sp.direction as never } : {}),
    ...(sp.account ? { OR: [{ accountId: sp.account }, { toAccountId: sp.account }] } : {}),
    ...(sp.store ? { storeId: sp.store } : {}),
    ...(sp.from || sp.to ? { date: { ...(sp.from ? { gte: jakartaDateTime(sp.from, "00:00") } : {}), ...(sp.to ? { lt: new Date(jakartaDateTime(sp.to, "00:00").getTime() + 86400000) } : {}) } } : {}),
    ...(sp.q ? { OR: [{ number: { contains: sp.q, mode: "insensitive" } }, { note: { contains: sp.q, mode: "insensitive" } }, { counterparty: { contains: sp.q, mode: "insensitive" } }] } : {}),
  };
  const [rows, counts, banks, cats, stores] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { ...where, ...(status ? { status } : {}) }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200 }),
    prisma.financeTransaction.groupBy({ by: ["status"], where, _count: true }),
    prisma.bankAccount.findMany(),
    prisma.txCategory.findMany(),
    prisma.store.findMany(),
  ]);
  const name = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name ?? "—";
  const qs = (s?: string) => { const u = new URLSearchParams(Object.entries({ ...sp, status: s }).filter(([, v]) => v) as [string, string][]); return `/finance?${u}`; };
  return (
    <div>
      <PageHeader title="Finance Inbox" subtitle="Transaksi dari input manual, Telegram, dan ekstraksi AI · IDR · WIB" actions={<>{user.can("finance.approve") && <Link href="/finance/sisihan" className="btn-secondary">Dana sisihan</Link>}{user.can("finance.create") && <Link href="/finance/baru" className="btn-primary">+ Transaksi</Link>}</>} />
      <Tabs current={status ?? "ALL"} tabs={[{ key: "ALL", label: "Semua", href: qs(undefined), count: counts.reduce((s, c) => s + c._count, 0) }, ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], href: qs(s), count: counts.find((c) => c.status === s)?._count ?? 0 }))]} />
      <FilterBar>
        {status && <input type="hidden" name="status" value={status} />}
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="No. / catatan / pihak" /></Field>
        <Field label="Sumber"><select name="source" defaultValue={sp.source ?? ""} className="input"><option value="">Semua</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Jenis"><select name="direction" defaultValue={sp.direction ?? ""} className="input"><option value="">Semua</option><option value="MASUK">Masuk</option><option value="KELUAR">Keluar</option><option value="TRANSFER">Transfer</option></select></Field>
        <Field label="Rekening"><select name="account" defaultValue={sp.account ?? ""} className="input"><option value="">Semua</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Toko"><select name="store" defaultValue={sp.store ?? ""} className="input"><option value="">Semua</option>{stores.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
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
                    <div><div className="text-xs text-slate-400">{t.number} · {SOURCE[t.source]}</div><div className="text-sm font-medium">{t.note || name(cats, t.categoryId)}</div></div>
                    <div className={`text-right font-semibold tabular-nums ${t.direction === "MASUK" ? "text-emerald-600" : t.direction === "KELUAR" ? "text-rose-600" : "text-slate-700"}`}>{t.direction === "KELUAR" ? "−" : t.direction === "MASUK" ? "+" : "⇄"}{idr(t.amount)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{fmtDateTime(t.date)} · {name(banks, t.accountId)}</span><Badge tone={TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="table-wrap hidden md:block">
            <table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Jenis</th><th className="num">Nominal</th><th>Status</th><th>Rekening</th><th>Kategori</th><th>Sumber</th><th>Catatan</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td><Link className="link font-mono text-xs" href={`/finance/${t.id}`}>{t.number}</Link>{t.duplicateOfId && <span title="Terindikasi duplikat" className="ml-1">⚠️</span>}{t.proofPath && <span title="Ada bukti" className="ml-1">📎</span>}</td>
                    <td>{fmtDateTime(t.date)}</td><td>{t.direction === "MASUK" ? "Masuk" : t.direction === "KELUAR" ? "Keluar" : "Transfer"}</td>
                    <td className={`num font-medium ${t.direction === "MASUK" ? "text-emerald-600" : t.direction === "KELUAR" ? "text-rose-600" : ""}`}>{idr(t.amount)}</td>
                    <td><Badge tone={TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></td>
                    <td>{name(banks, t.accountId)}{t.direction === "TRANSFER" && ` → ${name(banks, t.toAccountId)}`}</td>
                    <td>{t.direction === "TRANSFER" ? "—" : name(cats, t.categoryId)}</td>
                    <td>{SOURCE[t.source]}</td>
                    <td className="max-w-[180px] truncate">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
