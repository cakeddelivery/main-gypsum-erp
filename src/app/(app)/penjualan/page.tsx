import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { dashboardData, latestMonth } from "@/lib/marketplace/dashboard";
import { syncStatus } from "@/lib/marketplace/sync";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { BarsChart, TrendChart } from "@/components/Charts";
import { saveSyncAction } from "./marketplace/actions";
import { MpNav } from "./marketplace/MpNav";

export const metadata = { title: "Penjualan · Dashboard Marketplace" };
const MONTH = /^\d{4}-\d{2}$/;
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
const TONE = { OK: "green", PERINGATAN: "amber", MERAH: "red" } as const;
const LABEL = { OK: "Terbaru", PERINGATAN: "Telat 1 hari", MERAH: "Telat" } as const;

/** Halaman awal menu Penjualan = dashboard marketplace; tombol "Penjualan" membuka penjualan offline */
export default async function PenjualanDashboard({ searchParams }: { searchParams: Promise<{ bulan?: string; toko?: string }> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const sp = await searchParams;
  const month = MONTH.test(sp.bulan ?? "") ? sp.bulan! : await latestMonth();
  const [stores, d, sync] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    dashboardData({ month, storeId: sp.toko || undefined }),
    syncStatus(),
  ]);
  const noData = d.orders === 0 && d.batal === 0;
  const [y, m] = month.split("-").map(Number);
  const channelPotongan = d.potongan.map((p) => ({ label: p.label, "Potongan %": p.gross ? Math.round((Math.abs(p.counted) / p.gross) * 1000) / 10 : 0 }));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Penjualan"
        subtitle={`Dashboard marketplace · ${BULAN[m - 1]} ${y}`}
        actions={<><Link href="/penjualan/offline" className="btn-secondary">Penjualan</Link><Link href="/penjualan/invoice" className="btn-secondary">Invoice</Link><Link href="/penjualan/marketplace/impor" className="btn-primary">Impor data</Link></>}
      />
      <MpNav current="dashboard" />

      {(sync.active || canManage) && (
        <Card title="Pembaruan data harian">
          {sync.active ? (
            <>
              {sync.stale > 0 ? (
                <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${sync.worst === "MERAH" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                  <b>{sync.stale} data belum diperbarui.</b> Order & penghasilan harus diunggah setiap hari (mulai {sync.start}) — tugas Supervisor, Owner sebagai cadangan. <Link href="/penjualan/marketplace/impor" className="underline">Impor sekarang</Link>
                </div>
              ) : <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Semua data order & penghasilan sudah diperbarui (diwajibkan sampai {sync.required}).</div>}
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Toko</th><th>Kanal</th><th>File</th><th>Terakhir diunggah</th><th>Status</th></tr></thead>
                <tbody>{sync.rows.map((r) => <tr key={r.storeId + r.channel + r.kind}><td>{r.store}</td><td>{CHANNEL_LABEL[r.channel]}</td><td>{r.kind === "ORDER" ? "Order" : "Penghasilan"}</td><td>{r.last ? fmtDateTime(r.last) : "belum pernah"}</td><td><Badge tone={TONE[r.status]}>{LABEL[r.status]}{r.behind > 1 ? ` ${r.behind} hari` : ""}</Badge></td></tr>)}</tbody>
              </table></div>
            </>
          ) : <p className="text-sm text-slate-500">Belum diatur. Tetapkan tanggal mulai agar data wajib diperbarui tiap hari dan pengingat dikirim ke Supervisor (Owner cadangan).</p>}
          {canManage && (
            <ActionForm action={saveSyncAction} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Wajib diperbarui mulai tanggal"><input type="date" name="start" defaultValue={sync.start ?? ""} className="input" /></Field>
              <Field label="Pengingat pukul"><input type="number" name="hour" min={0} max={21} defaultValue={sync.hour} className="input w-24" /></Field>
              <Submit className="btn-secondary">Simpan</Submit>
              <p className="w-full text-xs text-slate-500">Kosongkan tanggal untuk mematikan. Pengingat ke Supervisor pada jam ini; Owner 2 jam kemudian bila masih belum diperbarui.</p>
            </ActionForm>
          )}
        </Card>
      )}

      <FilterBar>
        <Field label="Bulan"><input type="month" name="bulan" defaultValue={month} className="input" /></Field>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>

      {noData ? <Empty title="Belum ada pesanan pada bulan ini" hint="Pilih bulan lain atau unggah file order di menu Impor." action={<Link href="/penjualan/marketplace/impor" className="btn-primary">Impor data</Link>} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Omzet marketplace" value={idr(d.omzet)} tone="blue" hint={`${d.orders.toLocaleString("id-ID")} pesanan · rata-rata ${idr(d.avg)}`} />
            <Stat label="Piutang (belum cair)" value={idr(d.summary.piutang)} tone="amber" hint={`${d.summary.piutangCount} pesanan`} href="/penjualan/marketplace?tab=PIUTANG" />
            <Stat label="Saldo di marketplace" value={idr(d.summary.saldo)} hint="cair, belum ditarik" href="/penjualan/marketplace/saldo" />
            <Stat label="Sudah ditarik bulan ini" value={idr(d.summary.withdrawnMonth)} tone="green" />
            <Stat label="Potongan platform" value={idr(d.summary.fees)} hint={d.omzet ? `${pc((d.summary.fees / d.omzet) * 100)} dari omzet` : undefined} href="/penjualan/marketplace/potongan" />
            <Stat label="Retur" value={`${d.retur}`} tone="red" hint={d.orders ? `${pc((d.retur / d.orders) * 100)} dari pesanan` : undefined} href="/penjualan/marketplace?tab=RETUR" />
            <Stat label="Batal" value={`${d.batal}`} />
            <Stat label="Pesanan affiliate" value={`${d.perStore.reduce((a, s) => a + s.affiliate, 0)}`} href="/penjualan/marketplace/affiliate" />
          </div>

          <Card title="Omzet per hari (Shopee vs TikTok)"><TrendChart data={d.daily} series={[{ key: "SHP", label: "Shopee", color: "#f97316" }, { key: "TTS", label: "TikTok", color: "#0ea5e9" }]} /></Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Jumlah pesanan per hari"><BarsChart data={d.daily} series={[{ key: "pesananSHP", label: "Shopee", color: "#f97316" }, { key: "pesananTTS", label: "TikTok", color: "#0ea5e9" }]} /></Card>
            <Card title="Uang cair per hari"><TrendChart data={d.daily} series={[{ key: "cair", label: "Cair (setelah potongan)", color: "#16a34a" }]} /></Card>
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
