import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { affiliateReport } from "@/lib/marketplace/potongan";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { PeriodFilter } from "../PeriodFilter";
import { resolvePeriod } from "@/lib/marketplace/periode";
import { Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { MpNav } from "../MpNav";

export const metadata = { title: "Affiliate Marketplace" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;

type Row = { name: string; orders: number; omzet: number; komisi: number; pct: number };
function T({ rows, first, label = (x: string) => x }: { rows: Row[]; first: string; label?: (x: string) => string }) {
  return (
    <div className="table-wrap"><Paged size={12}><table className="tbl">
      <thead><tr><th>{first}</th><th className="num">Pesanan</th><th className="num">Omzet</th><th className="num">Komisi</th><th className="num">% komisi</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.name}><td>{label(r.name)}</td><td className="num">{r.orders}</td><td className="num">{idr(r.omzet)}</td><td className="num">{idr(Math.round(r.komisi))}</td><td className="num">{pc(r.pct)}</td></tr>)}</tbody>
    </table></Paged></div>
  );
}

export default async function AffiliatePage({ searchParams }: { searchParams: Promise<{ toko?: string; kanal?: string; dari?: string; sampai?: string; periode?: string; bulan?: string }> }) {
  await requirePerm("sales.view");
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const { from, to } = period;
  const [stores, r] = await Promise.all([prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }), affiliateReport({ storeId: sp.toko || undefined, channel: sp.kanal === "SHP" || sp.kanal === "TTS" ? sp.kanal : undefined, from, to })]);
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  return (
    <div className="space-y-4">
      <PageHeader title="Affiliate" subtitle="TikTok: kreator terisi / komisi afiliasi · Shopee: komisi AMS · yang disimpan hanya kreator, bukan data pembeli" />
      <MpNav current="affiliate" />
      <PeriodFilter sp={sp} period={period} />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Kanal"><select name="kanal" defaultValue={sp.kanal ?? ""} className="input"><option value="">Semua</option><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
        {[["periode", sp.periode], ["bulan", sp.bulan], ["dari", sp.dari], ["sampai", sp.sampai]].map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      </FilterBar>
      {r.totalOrders === 0 ? <Empty title="Belum ada pesanan pada periode ini" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Pesanan affiliate" value={r.aff.orders.toLocaleString("id-ID")} hint={`${pc(r.pctOrders)} dari ${r.totalOrders.toLocaleString("id-ID")} pesanan`} />
            <Stat label="Omzet affiliate" value={idr(r.aff.omzet)} />
            <Stat label="Komisi" value={idr(Math.round(r.aff.komisi))} tone="amber" />
            <Stat label="% komisi dari omzet" value={pc(r.komisiPct)} tone="amber" />
          </div>
          <Card title="Per toko"><T rows={r.byStore} first="Toko" label={(x) => sn.get(x) ?? x} /></Card>
          <Card title="Per kanal"><T rows={r.byChannel} first="Kanal" label={(x) => CHANNEL_LABEL[x] ?? x} /></Card>
          <Card title="Per kreator"><T rows={r.byCreator} first="Kreator" /></Card>
          <Card title="Per produk"><T rows={r.byProduct} first="Produk" /></Card>
        </>
      )}
    </div>
  );
}
