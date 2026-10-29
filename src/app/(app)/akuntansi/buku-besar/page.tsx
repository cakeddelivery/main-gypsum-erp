import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ledger } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { parseRange, ReportFilter, type SP } from "../shared";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Buku Besar" };

export default async function BukuBesar({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const accounts = await prisma.coaAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const accountId = sp.account && accounts.some((a) => a.id === sp.account) ? sp.account : (accounts.find((a) => a.isCash && a.code !== "1-1100") ?? accounts[0]).id;
  const l = await ledger(accountId, { start: r.start, end: r.end, storeId: r.storeId });
  return (
    <div>
      <PageHeader title="Buku besar" subtitle={`${l.account.code} ${l.account.name}`} actions={<><DownloadJpg targetId="bb" filename={`buku-besar-${l.account.code}`} /></>} />
      <ReportFilter sp={sp} extra={<Field label="Akun"><select name="account" defaultValue={accountId} className="input">{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>} />
      <div id="bb" className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Tanggal</th><th>No. jurnal</th><th>Keterangan</th><th className="num">Debit</th><th className="num">Kredit</th><th className="num">Saldo</th></tr></thead>
          <tbody>
            <tr className="bg-slate-50"><td colSpan={5}>Saldo awal</td><td className="num font-semibold">{idr(l.opening)}</td></tr>
            {l.rows.map((x) => <tr key={x.id}><td>{fmtDateTime(x.date)}</td><td className="font-mono text-xs">{x.number}</td><td className="max-w-xs truncate">{x.description}{x.memo && <span className="text-xs text-slate-400"> · {x.memo}</span>}</td><td className="num">{x.debit ? idr(x.debit) : ""}</td><td className="num">{x.credit ? idr(x.credit) : ""}</td><td className="num">{idr(x.balance)}</td></tr>)}
          </tbody>
          <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={5}>Saldo akhir</td><td className="num">{idr(l.closing)}</td></tr></tfoot>
        </table></Paged>
      </div>
    </div>
  );
}
