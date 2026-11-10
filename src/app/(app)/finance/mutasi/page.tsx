import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ledger } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Badge, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { parseRange, type SP } from "../../akuntansi/shared";

export const metadata = { title: "Mutasi Rekening" };

/** Label sumber jurnal agar mudah dicocokkan dengan mutasi bank */
const SOURCE: Record<string, string> = {
  FINANCE: "Transaksi", PAYROLL_AKRUAL: "Gaji terutang", PEMBELIAN: "Pembelian", UTANG: "Bayar hutang", PINJAMAN: "Pinjaman", PAYROLL: "Gaji", KASBON: "Kasbon",
  BORONGAN: "Upah borongan", SISIHAN: "Dana sisihan", SALDO_AWAL: "Saldo awal/penyesuaian", PEMBALIK: "Pembatalan", PIUTANG: "Piutang",
  ASET: "Aset", MANUAL: "Jurnal manual", PENYESUAIAN: "Penyesuaian", WITHDRAW_PENJUALAN: "Withdraw", WD_DITERIMA: "Withdraw diterima", PENJUALAN: "Penjualan",
};

/**
 * Semua uang masuk & keluar satu rekening dari seluruh menu (Transaksi, pembelian, gaji, kasbon, borongan, sisihan, hutang),
 * urut seperti mutasi bank, untuk dicocokkan dengan mutasi asli.
 */
export default async function MutasiRekening({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("finance.approve", "accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const bank = banks.find((b) => b.id === sp.bank) ?? banks[0];
  if (!bank) return <PageHeader title="Mutasi rekening" subtitle="Belum ada rekening aktif" />;
  const l = await ledger(bank.coaAccountId, { start: r.start, end: r.end });
  const journals = await prisma.journal.findMany({ where: { number: { in: l.rows.map((x) => x.number) } }, select: { number: true, source: true } });
  const src = (n: string) => journals.find((j) => j.number === n)?.source ?? "";
  const masuk = l.rows.reduce((s, x) => s + x.debit, 0);
  const keluar = l.rows.reduce((s, x) => s + x.credit, 0);
  return (
    <div>
      <PageHeader
        title="Mutasi rekening"
        subtitle="Semua uang masuk & keluar rekening dari seluruh menu, untuk dicocokkan dengan mutasi bank"
        actions={<><Link href="/finance" className="btn-secondary">Transaksi</Link><DownloadCsv filename={`mutasi-${bank.code}-${r.from}-${r.to}`} rows={[["Waktu", "No. jurnal", "Sumber", "Keterangan", "Masuk", "Keluar", "Saldo"], ["", "", "", "Saldo awal", "", "", l.opening], ...l.rows.map((x) => [fmtDateTime(x.date), x.number, SOURCE[src(x.number)] ?? src(x.number), x.description, x.debit, x.credit, x.balance])]} /></>}
      />
      <FilterBar>
        <Field label="Rekening"><select name="bank" defaultValue={bank.id} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Dari"><input type="date" name="from" defaultValue={r.from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="to" defaultValue={r.to} className="input" /></Field>
      </FilterBar>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo awal" value={idr(l.opening)} />
        <Stat label="Masuk" value={idr(masuk)} tone="green" />
        <Stat label="Keluar" value={idr(keluar)} tone="red" />
        <Stat label="Saldo akhir" value={idr(l.closing)} tone="blue" />
      </div>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Waktu</th><th>Sumber</th><th>Keterangan</th><th className="num">Masuk</th><th className="num">Keluar</th><th className="num">Saldo</th></tr></thead>
          <tbody>
            {l.rows.map((x) => (
              <tr key={x.id}>
                <td>{fmtDateTime(x.date)}<div className="font-mono text-xs text-slate-400">{x.number}</div></td>
                <td><Badge tone={src(x.number) === "FINANCE" ? "gray" : "purple"}>{SOURCE[src(x.number)] ?? src(x.number)}</Badge></td>
                <td className="max-w-xs truncate">{x.description}</td>
                <td className="num text-emerald-600">{x.debit ? idr(x.debit) : ""}</td>
                <td className="num text-rose-600">{x.credit ? idr(x.credit) : ""}</td>
                <td className="num">{idr(x.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table></Paged>
      </div>
    </div>
  );
}
