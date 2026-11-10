import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
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
  const [pl0, lh, store, opnameHpp, zeroHpp] = await Promise.all([
    profitLoss({ start: r.start, end: r.end, storeId: r.storeId }),
    letterhead(),
    storeLabel(r.storeId),
    prisma.journal.count({ where: { date: { gte: r.start, lt: r.end }, source: "STOK", description: { startsWith: "Barang terjual (opname)" } } }),
    prisma.saleLine.count({ where: { unitCost: 0, sale: { date: { gte: r.start, lt: r.end }, cancelledAt: null } } }),
  ]);
  // Akun pendapatan bersaldo debit (mis. Retur & Refund Penjualan) = pengurang pendapatan
  const pl = { ...pl0, revenue: pl0.revenue.map((a) => (a.amount < 0 ? { ...a, name: `${a.name} (pengurang)` } : a)) };
  const period = fmtRange(r.from, r.to);
  const notes = [
    ...(opnameHpp ? [] : ["HPP penjualan marketplace dibukukan saat opname barang jadi akhir bulan. Belum ada opname di periode ini, jadi laba kotor belum final (terlalu tinggi)."]),
    ...(zeroHpp ? [`${zeroHpp} baris penjualan offline tercatat dengan HPP Rp0 (harga pokok barang jadi & resep belum ada). Lengkapi resep di Produk & HPP.`] : []),
  ];
  return (
    <div>
      <PageHeader title="Laporan laba rugi" actions={<><DownloadCsv filename={`laba-rugi-${r.from}-${r.to}`} rows={accountCsv(`Laba rugi ${period}`, [["Pendapatan", pl.revenue, pl.totalRevenue], ["Harga pokok penjualan", pl.cogs, pl.totalCogs], ["Beban operasional", pl.expenses, pl.totalExpenses]], [["Laba kotor", pl.grossProfit], ["Laba (rugi) bersih", pl.netProfit]])} /><DownloadJpg targetId="lr" filename={`laba-rugi-${r.from}-${r.to}`} /></>} />
      <ReportFilter sp={sp} />
      {notes.map((n) => <p key={n} className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{n}</p>)}
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
          notes={[`Laporan ini merupakan laporan laba rugi ${store.charAt(0).toLowerCase() + store.slice(1)}.`, `Periode laporan: ${period}.`, ...notes, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
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
