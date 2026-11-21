import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { dashboardData, periodTotals } from "@/lib/marketplace/dashboard";
import { deltaPct, resolvePeriod } from "@/lib/marketplace/periode";
import { PeriodFilter } from "./marketplace/PeriodFilter";
import { syncStatus } from "@/lib/marketplace/sync";
import { wdReminderHour } from "@/lib/marketplace/saldo";
import { loadBrands } from "@/lib/marketplace/slots";
import { PengaturanMarketplace } from "./marketplace/PengaturanMarketplace";
import { completeness } from "@/lib/marketplace/kelengkapan";
import { Kelengkapan } from "./marketplace/Kelengkapan";
import { PiutangWarning } from "@/components/PiutangWarning";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { BarsChart, TrendChart } from "@/components/Charts";
import { ImportBannerServer } from "@/components/ImportBannerServer";
import { MpNav } from "./marketplace/MpNav";

export const metadata = { title: "Penjualan · Dashboard Marketplace" };
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
const TONE = { OK: "green", PERINGATAN: "amber", MERAH: "red" } as const;
const LABEL = { OK: "Terbaru", PERINGATAN: "Telat 1 hari", MERAH: "Telat" } as const;

/** Halaman awal menu Penjualan = dashboard marketplace; tombol "Penjualan" membuka penjualan offline */
export default async function PenjualanDashboard({ searchParams }: { searchParams: Promise<{ periode?: string; bulan?: string; dari?: string; sampai?: string; toko?: string }> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const storeFilter = sp.toko || undefined;
  const [stores, d, prev, sync, matrix, wdHour] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    dashboardData({ from: period.from, to: period.to, weekly: period.weekly, storeId: storeFilter }),
    periodTotals({ from: period.prevFrom, to: period.prevTo, storeId: storeFilter }),
    syncStatus(),
    completeness(),
    wdReminderHour(),
  ]);
  const brands = await loadBrands(stores);
  const noData = d.orders === 0 && d.batal === 0;
  const channelPotongan = d.potongan.map((p) => ({ label: p.label, "Potongan %": p.gross ? Math.round((Math.abs(p.counted) / p.gross) * 1000) / 10 : 0 }));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Penjualan"
        subtitle={`Dashboard marketplace · ${period.label}`}
        actions={<><Link href="/penjualan/offline" className="btn-secondary">Penjualan</Link><Link href="/penjualan/invoice" className="btn-secondary">Invoice</Link>{canManage && <PengaturanMarketplace sync={sync} wdHour={wdHour} matrix={matrix} stores={stores} brands={brands} />}<Link href="/penjualan/marketplace/impor" className="btn-primary">Impor data</Link></>}
      />
      <MpNav current="dashboard" />
      <ImportBannerServer />
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Angka marketplace = data operasional dari file; tidak masuk jurnal. Pendapatan akuntansi dicatat dari withdraw — jangan dijumlahkan dengan laporan Laba.</p>

      <DataBadge matrix={matrix} sync={sync} />
      {matrix.rows.length > 0 && <Kelengkapan m={matrix} canManage={false} stores={stores} compact />}

      <PeriodFilter sp={sp} period={period} compare />
      <FilterBar>
        {sp.periode && <input type="hidden" name="periode" value={sp.periode} />}{sp.bulan && <input type="hidden" name="bulan" value={sp.bulan} />}{sp.dari && <input type="hidden" name="dari" value={sp.dari} />}{sp.sampai && <input type="hidden" name="sampai" value={sp.sampai} />}
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>

      {noData ? <Empty title="Belum ada pesanan pada periode ini" hint="Pilih periode lain atau unggah file order di menu Impor." action={<Link href="/penjualan/marketplace/impor" className="btn-primary">Impor data</Link>} /> : (
        <>
          <PiutangWarning stores={stores} storeId={sp.toko || undefined} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Omzet marketplace" value={idr(d.omzet)} tone="blue" hint={<><div>{`${d.orders.toLocaleString("id-ID")} pesanan · rata-rata ${idr(d.avg)}`}</div><Delta cur={d.omzet} prev={prev.omzet} /><Delta cur={d.orders} prev={prev.orders} label="pesanan" /></>} />
            <Stat label="Piutang (belum cair)" value={idr(d.summary.piutang)} tone="amber" hint={<><div>{`${d.summary.piutangCount} pesanan`}</div><Delta cur={d.summary.piutang} prev={prev.piutang} badUp /></>} href="/penjualan/marketplace?tab=PIUTANG" />
            <Stat label="Saldo di marketplace" value={idr(d.summary.saldo)} hint="cair, belum ditarik" href="/penjualan/marketplace/saldo" />
            <Stat label="Sudah ditarik (periode ini)" value={idr(d.summary.withdrawnMonth)} tone="green" />
            <Stat label="Potongan platform" value={idr(d.summary.fees)} hint={<>{d.omzet ? <div>{`${pc((d.summary.fees / d.omzet) * 100)} dari omzet`}</div> : null}<Delta cur={d.summary.fees} prev={prev.fees} badUp /></>} href="/penjualan/marketplace/potongan" />
            <Stat label="Retur" value={`${d.retur}`} tone="red" hint={d.orders ? `${pc((d.retur / d.orders) * 100)} dari pesanan` : undefined} href="/penjualan/marketplace?tab=RETUR" />
            <Stat label="Batal" value={`${d.batal}`} />
            <Stat label="Pesanan affiliate" value={`${d.perStore.reduce((a, s) => a + s.affiliate, 0)}`} href="/penjualan/marketplace/affiliate" />
          </div>

          <Card title={`Omzet per ${period.weekly ? "minggu" : "hari"} (Shopee vs TikTok)`}><TrendChart data={d.daily} series={[{ key: "SHP", label: "Shopee", color: "#f97316" }, { key: "TTS", label: "TikTok", color: "#0ea5e9" }]} /></Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`Jumlah pesanan per ${period.weekly ? "minggu" : "hari"}`}><BarsChart data={d.daily} series={[{ key: "pesananSHP", label: "Shopee", color: "#f97316" }, { key: "pesananTTS", label: "TikTok", color: "#0ea5e9" }]} /></Card>
            <Card title={`Uang cair per ${period.weekly ? "minggu" : "hari"}`}><TrendChart data={d.daily} series={[{ key: "cair", label: "Cair (setelah potongan)", color: "#16a34a" }]} /></Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Per toko & kanal">
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Toko</th><th>Kanal</th><th className="num">Pesanan</th><th className="num">Omzet</th><th className="num">Batal</th><th className="num">Retur</th></tr></thead>
                <tbody>{d.perStore.map((s) => <tr key={s.store + s.channel}><td>{s.store}</td><td>{CHANNEL_LABEL[s.channel]}</td><td className="num">{s.orders}</td><td className="num">{idr(s.omzet)}</td><td className="num">{s.batal}</td><td className="num">{s.retur}</td></tr>)}</tbody>
              </table></div>
            </Card>
            <Card title="Potongan platform per kanal (% omzet)"><BarsChart data={channelPotongan} series={[{ key: "Potongan %", label: "Potongan %", color: "#e11d48" }]} /></Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Produk terlaris (omzet)">
              <div className="table-wrap"><table className="tbl"><thead><tr><th>Produk</th><th className="num">Qty</th><th className="num">Omzet</th></tr></thead>
                <tbody>{d.topProducts.map((p) => <tr key={p.name}><td className="max-w-[16rem] truncate" title={p.name}>{p.name}</td><td className="num">{p.qty}</td><td className="num">{idr(p.omzet)}</td></tr>)}</tbody></table></div>
            </Card>
            <Card title="Kota pembeli terbanyak" actions={<Link href="/penjualan/marketplace/wilayah" className="link text-sm">Laporan wilayah</Link>}>
              <div className="table-wrap"><table className="tbl"><thead><tr><th>Kota/Kab.</th><th className="num">Pesanan</th></tr></thead>
                <tbody>{d.topCities.map((c) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.orders}</td></tr>)}</tbody></table></div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** Selisih terhadap periode sebelumnya yang sama panjang (▲/▼ %). badUp: kenaikan = buruk (piutang, potongan) */
function Delta({ cur, prev, label, badUp = false }: { cur: number; prev: number; label?: string; badUp?: boolean }) {
  const d = deltaPct(cur, prev);
  if (d === null) return <div className="text-slate-400">{label ? `${label}: ` : ""}tanpa pembanding</div>;
  const up = d > 0, good = d === 0 ? null : badUp ? !up : up;
  return <div className={good === null ? "text-slate-500" : good ? "text-emerald-600" : "text-rose-600"}>{up ? "▲" : d < 0 ? "▼" : "•"} {Math.abs(d).toLocaleString("id-ID")}%{label ? ` ${label}` : ""} vs periode lalu</div>;
}

/** Ringkasan status data: "Data lengkap ✓" atau "N file belum diunggah ⚠" (klik → halaman Impor) */
function DataBadge({ matrix, sync }: { matrix: Awaited<ReturnType<typeof completeness>>; sync: Awaited<ReturnType<typeof syncStatus>> }) {
  const n = matrix.missing.length || sync.stale;
  const empty = matrix.rows.length === 0;
  const waiting = matrix.gaps.filter((g) => g.paused).length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Link href="/penjualan/marketplace/impor" className={`rounded-full px-3 py-1 font-medium ${empty ? "bg-slate-100 text-slate-600" : n ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}>
        {empty ? "Belum ada data diunggah" : n ? `${n} file belum diunggah ⚠` : "Data lengkap ✓"}
      </Link>
      {waiting > 0 && <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">⏸ {waiting} menunggu akses</span>}
      <span className="text-xs text-slate-500">{matrix.start ? `wajib sejak ${matrix.start}` : "tanggal mulai belum diatur (⚙ Pengaturan)"}</span>
    </div>
  );
}
