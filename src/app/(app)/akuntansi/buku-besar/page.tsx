import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ledger } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { letterhead } from "@/lib/letterhead";
import { Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocBar, DocSection, DocSheet, DocTable, fmtLong, fmtRange } from "@/components/DocSheet";
import { parseRange, ReportFilter, signerOf, storeLabel, type SP } from "../shared";

export const metadata = { title: "Buku Besar" };
const num = (v: number) => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("id-ID");

export default async function BukuBesar({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const accounts = await prisma.coaAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const accountId = sp.account && accounts.some((a) => a.id === sp.account) ? sp.account : (accounts.find((a) => a.isCash && a.code !== "1-1100") ?? accounts[0]).id;
  const [l, lh, store] = await Promise.all([ledger(accountId, { start: r.start, end: r.end, storeId: r.storeId }), letterhead(), storeLabel(r.storeId)]);
  const period = fmtRange(r.from, r.to);
  const debit = l.rows.reduce((s, x) => s + Number(x.debit || 0), 0);
  const credit = l.rows.reduce((s, x) => s + Number(x.credit || 0), 0);
  return (
    <div>
      <PageHeader title="Buku besar" subtitle={`${l.account.code} ${l.account.name}`} actions={<DownloadJpg targetId="bb" filename={`buku-besar-${l.account.code}`} />} />
      <ReportFilter sp={sp} extra={<Field label="Akun"><select name="account" defaultValue={accountId} className="input">{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>} />
      <DocSheet
        id="bb" lh={lh} eyebrow="Laporan keuangan" title="Buku Besar" subtitle={`${l.account.code} ${l.account.name} · ${store}`}
        meta={{ label: "Periode Laporan", value: period }} signerOrg={signerOf(store)} signDate={r.to}
        notes={[`Mutasi akun ${l.account.code} ${l.account.name} (${store.charAt(0).toLowerCase() + store.slice(1)}).`, `Periode laporan: ${period}.`, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
      >
        <DocBar label="Saldo awal" note={`Saldo per ${fmtLong(r.from)}`} value={idr(l.opening)} negative={l.opening < 0} />
        <DocSection no={1} title="Mutasi akun" hint={`${l.rows.length} transaksi · debit ${idr(debit)} · kredit ${idr(credit)}`}>
          <DocTable head={<tr><th>Tanggal</th><th>No. Jurnal</th><th>Keterangan</th><th className="num">Debit (Rp)</th><th className="num">Kredit (Rp)</th><th className="num">Saldo (Rp)</th></tr>} empty={l.rows.length ? undefined : "Tidak ada transaksi pada periode ini"}>
            {l.rows.map((x) => (
              <tr key={x.id}>
                <td className="whitespace-nowrap">{fmtDate(x.date)}</td><td className="whitespace-nowrap">{x.number}</td>
                <td>{x.description}{x.memo && <span className="text-xs text-slate-500"> · {x.memo}</span>}</td>
                <td className="num">{x.debit ? num(Number(x.debit)) : "-"}</td><td className="num">{x.credit ? num(Number(x.credit)) : "-"}</td>
                <td className={`num ${x.balance < 0 ? "doc-neg" : ""}`}>{num(x.balance)}</td>
              </tr>
            ))}
          </DocTable>
        </DocSection>
        <DocBar label="Saldo akhir" note={`Saldo per ${fmtLong(r.to)}`} value={idr(l.closing)} negative={l.closing < 0} />
      </DocSheet>
    </div>
  );
}
