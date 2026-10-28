import { requirePerm } from "@/lib/auth";
import { trialBalance } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { PageHeader } from "@/components/ui";
import { BackLink, parseRange, ReportFilter, type SP } from "../shared";

export const metadata = { title: "Neraca Saldo" };

export default async function NeracaSaldo({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const rows = await trialBalance({ end: r.end, storeId: r.storeId });
  const d = rows.reduce((s, x) => s + x.debit, 0);
  const c = rows.reduce((s, x) => s + x.credit, 0);
  return (
    <div>
      <PageHeader title="Neraca saldo" actions={<BackLink />} />
      <ReportFilter sp={sp} showFrom={false} />
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Kode</th><th>Akun</th><th>Tipe</th><th className="num">Debit</th><th className="num">Kredit</th></tr></thead>
          <tbody>{rows.map((x) => <tr key={x.code}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td className="text-xs">{x.type}</td><td className="num">{x.debit ? idr(x.debit) : ""}</td><td className="num">{x.credit ? idr(x.credit) : ""}</td></tr>)}</tbody>
          <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={3}>Total {d === c ? "✓ seimbang" : "✗ tidak seimbang"}</td><td className="num">{idr(d)}</td><td className="num">{idr(c)}</td></tr></tfoot>
        </table>
      </div>
    </div>
  );
}
