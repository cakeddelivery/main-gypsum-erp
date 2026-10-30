import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { parseRange, ReportFilter, type SP } from "../shared";
import { JournalLines } from "../JournalLines";
import { manualJournal, reverse } from "../actions";

export const metadata = { title: "Jurnal Umum" };

export default async function JurnalPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const [journals, accounts] = await Promise.all([
    prisma.journal.findMany({ where: { date: { gte: r.start, lt: r.end }, ...(r.storeId ? { storeId: r.storeId } : {}), ...(sp.source ? { source: sp.source } : {}) }, include: { lines: { include: { account: true } }, store: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 }),
    prisma.coaAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);
  const reversed = new Set(journals.map((j) => j.reversalOfId).filter(Boolean));
  return (
    <div className="space-y-5">
      <PageHeader title="Jurnal umum" subtitle="Jurnal tidak dapat diubah; koreksi menggunakan jurnal pembalik" actions={<>{user.can("accounting.post") && (
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
      <ReportFilter sp={sp} extra={<Field label="Sumber"><select name="source" defaultValue={sp.source ?? ""} className="input"><option value="">Semua</option>{["FINANCE", "MANUAL", "PENYESUAIAN", "SALDO_AWAL", "PRODUKSI", "STOK", "PAYROLL", "PIUTANG", "UTANG", "ASET", "PENYUSUTAN", "PEMBALIK"].map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>} />
      {journals.length === 0 && <Card><p className="text-center text-sm text-slate-400">Tidak ada jurnal pada periode ini</p></Card>}
      {journals.map((j) => (
        <Card key={j.id} title={`${j.number} · ${j.description}`} actions={<div className="flex items-center gap-2"><Badge>{j.source}</Badge><Badge tone="purple">{j.store.name}</Badge>{user.can("accounting.post") && !j.reversalOfId && !reversed.has(j.id) && (
          <Modal trigger="Balik" triggerClass="btn-secondary btn-sm" title={`Jurnal pembalik ${j.number}`}>
            <ModalForm action={reverse} className="space-y-3"><input type="hidden" name="id" value={j.id} /><Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field><Field label="Alasan"><input name="reason" className="input" required /></Field><Submit className="btn-danger">Buat jurnal pembalik</Submit></ModalForm>
          </Modal>
        )}</div>}>
          <div className="mb-2 text-xs text-slate-500">{fmtDateTime(j.date)} · oleh {j.createdBy}</div>
          <table className="w-full text-sm"><tbody>{j.lines.map((l) => <tr key={l.id} className="border-b border-slate-100"><td className={`py-1 ${Number(l.credit) ? "pl-6" : ""}`}><span className="mr-2 font-mono text-xs text-slate-400">{l.account.code}</span>{l.account.name}{l.memo && <span className="text-xs text-slate-400"> · {l.memo}</span>}</td><td className="w-36 text-right tabular-nums">{Number(l.debit) ? idr(l.debit) : ""}</td><td className="w-36 text-right tabular-nums">{Number(l.credit) ? idr(l.credit) : ""}</td></tr>)}</tbody></table>
        </Card>
      ))}
    </div>
  );
}
