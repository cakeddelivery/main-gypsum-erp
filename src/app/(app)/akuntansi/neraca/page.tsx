import { requirePerm } from "@/lib/auth";
import { balanceSheet } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { letterhead } from "@/lib/letterhead";
import { PageHeader, Stat } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport, DocSheet, DocSummary, fmtLong } from "@/components/DocSheet";
import { AccountTable, parseRange, ReportFilter, Section, signerOf, storeLabel, type SP } from "../shared";

export const metadata = { title: "Neraca" };

export default async function Neraca({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const [bs, lh, store] = await Promise.all([balanceSheet(r.end, r.storeId), letterhead(), storeLabel(r.storeId)]);
  const per = fmtLong(r.to);
  return (
    <div>
      <PageHeader title="Neraca" actions={<DownloadJpg targetId="nr" filename={`neraca-${r.to}`} />} />
      <ReportFilter sp={sp} showFrom={false} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total aset" value={idr(bs.totalAssets)} />
        <Stat label="Total kewajiban" value={idr(bs.totalLiabilities)} />
        <Stat label="Total ekuitas" value={idr(bs.totalEquity)} />
        <Stat label="Status" value={bs.balanced ? "✓ Seimbang" : "✗ Tidak seimbang"} tone={bs.balanced ? "green" : "red"} hint={`Per ${per}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <AccountTable title="Aset" rows={bs.assets} total={bs.totalAssets} totalLabel="Total aset" />
        <div className="space-y-4">
          <AccountTable title="Kewajiban" rows={bs.liabilities} total={bs.totalLiabilities} totalLabel="Total kewajiban" />
          <AccountTable title="Ekuitas" rows={[...bs.equity, { code: "—", name: "Laba (rugi) berjalan", amount: bs.currentEarnings }]} total={bs.totalEquity} totalLabel="Total ekuitas" />
        </div>
      </div>
      <DocExport>
        <DocSheet
          id="nr" lh={lh} eyebrow="Laporan keuangan" title="Neraca" subtitle={store}
          meta={{ label: "Posisi per tanggal", value: per }} signerOrg={signerOf(store)} signDate={r.to}
          notes={[`Laporan ini merupakan neraca (posisi keuangan) ${store.charAt(0).toLowerCase() + store.slice(1)}.`, `Posisi saldo per ${per}.`, bs.balanced ? "Neraca seimbang: total aset sama dengan total kewajiban + ekuitas." : "Neraca TIDAK seimbang: periksa jurnal.", "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
        >
          <Section no={1} tone="blue" title="Aset" hint="Kas, bank, persediaan, piutang, dan aset tetap" rows={bs.assets} total={bs.totalAssets} totalLabel="Total aset" />
          <Section no={2} tone="red" title="Kewajiban" hint="Utang usaha, pinjaman, dan kewajiban lainnya" rows={bs.liabilities} total={bs.totalLiabilities} totalLabel="Total kewajiban" />
          <Section no={3} tone="green" title="Ekuitas" hint="Modal pemilik dan laba ditahan" rows={[...bs.equity, { code: "—", name: "Laba (rugi) berjalan", amount: bs.currentEarnings }]} total={bs.totalEquity} totalLabel="Total ekuitas" />
          <DocSummary
            rows={[
              { label: "Total aset", value: idr(bs.totalAssets), negative: bs.totalAssets < 0 },
              { label: "Total kewajiban + ekuitas", hint: bs.balanced ? "✓ Neraca seimbang" : "✗ Neraca tidak seimbang — periksa jurnal", value: idr(bs.totalLiabilities + bs.totalEquity), strong: true, negative: !bs.balanced },
            ]}
          />
        </DocSheet>
      </DocExport>
    </div>
  );
}
