import { requirePerm } from "@/lib/auth";
import { profitLoss } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { letterhead } from "@/lib/letterhead";
import { PageHeader, Stat } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DownloadCsv } from "@/components/DownloadCsv";
import { DocExport, DocBar, DocSheet, DocSummary, fmtRange } from "@/components/DocSheet";
import { AccountTable, accountCsv, parseRange, ReportFilter, Section, signerOf, storeLabel, type SP } from "../shared";

export const metadata = { title: "Laba Rugi" };

export default async function LabaRugi({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const [pl, lh, store] = await Promise.all([profitLoss({ start: r.start, end: r.end, storeId: r.storeId }), letterhead(), storeLabel(r.storeId)]);
  const period = fmtRange(r.from, r.to);
  return (
    <div>
      <PageHeader title="Laporan laba rugi" actions={<><DownloadCsv filename={`laba-rugi-${r.from}-${r.to}`} rows={accountCsv(`Laba rugi ${period}`, [["Pendapatan", pl.revenue, pl.totalRevenue], ["Harga pokok penjualan", pl.cogs, pl.totalCogs], ["Beban operasional", pl.expenses, pl.totalExpenses]], [["Laba kotor", pl.grossProfit], ["Laba (rugi) bersih", pl.netProfit]])} /><DownloadJpg targetId="lr" filename={`laba-rugi-${r.from}-${r.to}`} /></>} />
      <ReportFilter sp={sp} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pendapatan" value={idr(pl.totalRevenue)} />
        <Stat label="Laba kotor" value={idr(pl.grossProfit)} tone={pl.grossProfit < 0 ? "red" : "slate"} />
        <Stat label="Beban operasional" value={idr(pl.totalExpenses)} />
        <Stat label="Laba (rugi) bersih" value={idr(pl.netProfit)} tone={pl.netProfit < 0 ? "red" : "green"} />
      </div>
      <div className="space-y-4">
        <AccountTable title="Pendapatan" rows={pl.revenue} total={pl.totalRevenue} totalLabel="Total pendapatan" />
        <AccountTable title="Harga pokok penjualan" rows={pl.cogs} total={pl.totalCogs} totalLabel="Total HPP" />
        <AccountTable title="Beban operasional" rows={pl.expenses} total={pl.totalExpenses} totalLabel="Total beban" />
      </div>
      <DocExport>
        <DocSheet
          id="lr" lh={lh} eyebrow="Laporan keuangan" title="Laporan Laba Rugi" subtitle={store}
          meta={{ label: "Periode Laporan", value: period }} signerOrg={signerOf(store)} signDate={r.to}
          notes={[`Laporan ini merupakan laporan laba rugi ${store.charAt(0).toLowerCase() + store.slice(1)}.`, `Periode laporan: ${period}.`, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
        >
          <Section no={1} tone="blue" title="Pendapatan" hint="Penjualan dan pendapatan usaha lainnya" rows={pl.revenue} total={pl.totalRevenue} totalLabel="Total pendapatan" />
          <Section no={2} tone="amber" title="Harga pokok penjualan" hint="Biaya bahan dan produksi dari barang yang terjual" rows={pl.cogs} total={pl.totalCogs} totalLabel="Total HPP" />
          <DocBar label="Laba kotor" value={idr(pl.grossProfit)} tone="green" negative={pl.grossProfit < 0} />
          <Section no={3} tone="red" title="Beban operasional" hint="Gaji, sewa, listrik, dan beban usaha lainnya" rows={pl.expenses} total={pl.totalExpenses} totalLabel="Total beban" />
          <DocSummary
            rows={[
              { label: "Laba kotor", hint: "Pendapatan dikurangi HPP", value: idr(pl.grossProfit), negative: pl.grossProfit < 0 },
              { label: "Laba (rugi) bersih", hint: "Laba kotor dikurangi beban operasional", value: idr(pl.netProfit), negative: pl.netProfit < 0, strong: true },
            ]}
          />
        </DocSheet>
      </DocExport>
    </div>
  );
}
