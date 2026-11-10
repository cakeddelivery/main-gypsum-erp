import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { TZ, todayStr } from "@/lib/time";
import { initials } from "@/lib/initials";
import { Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { parseRange, ReportFilter, type SP } from "../shared";
import { JournalLines } from "../JournalLines";
import { DownloadCsv } from "@/components/DownloadCsv";
import { manualJournal, reverse } from "../actions";
import { canReverseFromJournal, SOURCE_LABEL, sourceHref } from "@/lib/journalSource";

export const metadata = { title: "Jurnal Umum" };

const SOURCES = ["FINANCE", "WITHDRAW_PENJUALAN", "WD_DITERIMA", "PENJUALAN", "PEMBELIAN", "MANUAL", "PENYESUAIAN", "SALDO_AWAL", "PRODUKSI", "STOK", "PAYROLL", "PAYROLL_AKRUAL", "KASBON", "BORONGAN", "SISIHAN", "PIUTANG", "UTANG", "PINJAMAN", "ASET", "PENYUSUTAN", "PEMBALIK"];
const FIN_SOURCES = new Set(["FINANCE", "WITHDRAW_PENJUALAN", "WD_DITERIMA"]);
/** Sumber yang sourceId-nya sudah berupa nomor dokumen (PBL-…, KSB-…, UTG-…, PIU-…) */
const NUMBER_SOURCES = new Set(["PEMBELIAN", "KASBON", "UTANG", "PIUTANG", "PINJAMAN"]);

/** "10 Nov 12.58" (tahun ditampilkan bila bukan tahun ini) */
function shortStamp(d: Date) {
  const sameYear = d.toLocaleDateString("id-ID", { timeZone: TZ, year: "numeric" }) === new Date().toLocaleDateString("id-ID", { timeZone: TZ, year: "numeric" });
  const day = d.toLocaleDateString("id-ID", { timeZone: TZ, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  const time = d.toLocaleTimeString("id-ID", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}
const amt = (v: bigint) => (Number(v) ? Number(v).toLocaleString("id-ID") : null);
const pill = "inline-flex max-w-[9rem] items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset";

export default async function JurnalPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const [journals, accounts] = await Promise.all([
    prisma.journal.findMany({ where: { date: { gte: r.start, lt: r.end }, ...(r.storeId ? { storeId: r.storeId } : {}), ...(sp.source ? { source: sp.source } : {}) }, include: { lines: { include: { account: true } }, store: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 }),
    prisma.coaAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);

  // Nomor dokumen sumber untuk pill (TRX-…, JUAL-…, kode gaji, nomor jurnal asli untuk pembalik)
  const ids = (pred: (s: string) => boolean) => [...new Set(journals.filter((j) => pred(j.source) && j.sourceId).map((j) => j.sourceId!))];
  const [txs, sales, payrolls, origs, reversals] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { id: { in: ids((s) => FIN_SOURCES.has(s)) } }, select: { id: true, number: true, note: true, counterparty: true } }),
    prisma.sale.findMany({ where: { number: { in: ids((s) => s === "PENJUALAN") } }, select: { id: true, number: true } }),
    prisma.payrollPeriod.findMany({ where: { id: { in: ids((s) => s === "PAYROLL" || s === "PAYROLL_AKRUAL") } }, select: { id: true, code: true } }),
    prisma.journal.findMany({ where: { id: { in: journals.map((j) => j.reversalOfId).filter((x): x is string => !!x) } }, select: { id: true, number: true } }),
    prisma.journal.findMany({ where: { reversalOfId: { in: journals.map((j) => j.id) } }, select: { number: true, reversalOfId: true } }),
  ]);
  const txNo = new Map(txs.map((t) => [t.id, t.number]));
  const txTitle = new Map(txs.map((t) => [t.id, [t.counterparty, t.note].filter(Boolean).join(" · ")]));
  /** Judul kartu: keterangan jurnal, atau isi transaksi bila keterangannya hanya nomor TRX */
  const titleOf = (j: (typeof journals)[number]) => {
    if (!(FIN_SOURCES.has(j.source) && j.sourceId && j.description.trim() === txNo.get(j.sourceId))) return j.description;
    return txTitle.get(j.sourceId) || j.lines.find((l) => l.memo && l.memo !== j.description)?.memo || j.description;
  };
  const saleId = new Map(sales.map((s) => [s.number, s.id]));
  const payCode = new Map(payrolls.map((p) => [p.id, p.code]));
  const origNo = new Map(origs.map((o) => [o.id, o.number]));
  const reversedBy = new Map(reversals.map((x) => [x.reversalOfId!, x.number]));
  const docOf = (j: (typeof journals)[number]): { label: string; href: string | null } | null => {
    const sid = j.sourceId;
    if (j.reversalOfId) return origNo.has(j.reversalOfId) ? { label: `Balik ${origNo.get(j.reversalOfId)}`, href: null } : null;
    if (!sid) return null;
    if (FIN_SOURCES.has(j.source)) return { label: txNo.get(sid) ?? "Transaksi", href: sourceHref(j.source, sid) };
    if (j.source === "PENJUALAN") return { label: sid, href: sourceHref(j.source, sid, saleId.get(sid)) };
    if (j.source === "PAYROLL" || j.source === "PAYROLL_AKRUAL") return { label: payCode.get(sid) ?? "Gaji", href: sourceHref(j.source, sid) };
    if (NUMBER_SOURCES.has(j.source)) return { label: sid, href: sourceHref(j.source, sid) };
    return null;
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Jurnal umum" subtitle="Jurnal tidak dapat diubah; koreksi menggunakan jurnal pembalik" actions={<><DownloadCsv filename={`jurnal-${r.from}-${r.to}`} rows={[["Tanggal", "No. jurnal", "Sumber", "Keterangan", "Kode akun", "Akun", "Memo", "Debit", "Kredit"], ...journals.slice().reverse().flatMap((j) => j.lines.map((l) => [todayStr(j.date), j.number, j.source, j.description, l.account.code, l.account.name, l.memo ?? "", Number(l.debit), Number(l.credit)]))]} />{user.can("accounting.post") && (
        <Modal trigger="+ Jurnal manual" title="Jurnal manual / penyesuaian" wide>
          <ModalForm action={manualJournal} className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
              <Field label="Jenis"><select name="source" className="input"><option value="MANUAL">Jurnal umum</option><option value="PENYESUAIAN">Penyesuaian</option></select></Field>
              <Field label="Keterangan" className="col-span-2 md:col-span-1"><input name="description" className="input" required /></Field>
            </div>
            <JournalLines accounts={accounts} />
            <Submit>Bukukan</Submit>
          </ModalForm>
        </Modal>
      )}</>} />
      <ReportFilter sp={sp} extra={<Field label="Sumber"><select name="source" defaultValue={sp.source ?? ""} className="input"><option value="">Semua</option>{SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] ?? s}</option>)}</select></Field>} />
      {journals.length === 0 && <Card><p className="text-center text-sm text-slate-400">Tidak ada jurnal pada periode ini</p></Card>}
      {journals.map((j) => {
        const doc = docOf(j);
        const href = sourceHref(j.source, j.sourceId, j.source === "PENJUALAN" && j.sourceId ? saleId.get(j.sourceId) : null);
        const canReverse = user.can("accounting.post") && canReverseFromJournal(j) && !reversedBy.has(j.id);
        const showSourceBadge = !doc || j.reversalOfId || !FIN_SOURCES.has(j.source);
        return (
          <section key={j.id} className="card overflow-hidden" data-journal={j.number}>
            <div className="flex items-start justify-between gap-2 px-3 pb-1.5 pt-2.5">
              <div className="min-w-0">
                <div className="text-[11px] leading-4 text-slate-500"><span className="font-mono">{j.number}</span> · {shortStamp(j.date)} · {j.createdBy}</div>
                <div className="break-words text-sm font-semibold leading-5 text-slate-800">{titleOf(j)}</div>
              </div>
              <div className="flex max-w-[48%] shrink-0 flex-wrap justify-end gap-1">
                {doc && (doc.href ? <Link href={doc.href} className={`${pill} bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-100`}>{doc.label}</Link> : <span className={`${pill} bg-slate-50 text-slate-600 ring-slate-200`}>{doc.label}</span>)}
                <span className={`${pill} bg-purple-50 text-purple-700 ring-purple-200`} title={j.store.name}>{initials(j.store.name)}</span>
                {showSourceBadge && <span className={`${pill} bg-slate-50 text-slate-600 ring-slate-200`}>{SOURCE_LABEL[j.source] ?? j.source}</span>}
                {reversedBy.has(j.id) && <span className={`${pill} bg-rose-50 text-rose-700 ring-rose-200`}>Dibalik {reversedBy.get(j.id)}</span>}
              </div>
            </div>
            <table className="w-full table-fixed border-t border-slate-100 text-[13px]">
              <colgroup><col /><col className="w-[5.75rem]" /><col className="w-[5.75rem]" /></colgroup>
              <tbody>
                {j.lines.map((l) => {
                  const credit = Number(l.credit) > 0;
                  return (
                    <tr key={l.id} className="border-b border-slate-100 last:border-0">
                      <td className={`py-[5px] pr-2 align-top ${credit ? "pl-6" : "pl-3"}`}>
                        <span className="break-words text-slate-800">{l.account.name}</span> <span className="whitespace-nowrap font-mono text-[11px] text-slate-400">{l.account.code}</span>
                        {l.memo && l.memo !== j.description && <div className="break-words text-[11px] leading-4 text-slate-500">{l.memo}</div>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-[5px] text-right align-top tabular-nums">{amt(l.debit) ?? <span className="text-slate-300">—</span>}</td>
                      <td className="whitespace-nowrap py-[5px] pl-2 pr-3 text-right align-top tabular-nums">{amt(l.credit) ?? <span className="text-slate-300">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(canReverse || (!canReverseFromJournal(j) && !j.reversalOfId && href)) && (
              <div className="flex justify-end gap-2 border-t border-slate-100 px-3 py-1.5">
                {!canReverseFromJournal(j) && !j.reversalOfId && href && <Link href={href} className="btn-secondary btn-sm">Buka sumber</Link>}
                {canReverse && (
                  <Modal trigger="Balik" triggerClass="btn-secondary btn-sm" title={`Jurnal pembalik ${j.number}`}>
                    <ModalForm action={reverse} className="space-y-3"><input type="hidden" name="id" value={j.id} /><Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field><Field label="Alasan"><input name="reason" className="input" required /></Field><Submit className="btn-danger">Buat jurnal pembalik</Submit></ModalForm>
                  </Modal>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
