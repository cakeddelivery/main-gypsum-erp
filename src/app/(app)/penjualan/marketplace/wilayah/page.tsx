import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { regionReport, skuOverview, topCitiesForProduct } from "@/lib/marketplace/report";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { RegionTable } from "./RegionTable";
import { MpNav } from "../MpNav";

export const metadata = { title: "Wilayah Pembeli & Retur" };
type SP = { toko?: string; kanal?: string; dari?: string; sampai?: string; sku?: string; alasan?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;

export default async function WilayahPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("sales.view");
  const sp = await searchParams;
  const f = { storeId: sp.toko || undefined, channel: sp.kanal === "SHP" || sp.kanal === "TTS" ? sp.kanal : undefined, from: DATE.test(sp.dari ?? "") ? sp.dari : undefined, to: DATE.test(sp.sampai ?? "") ? sp.sampai : undefined, skuKey: sp.sku || undefined, reason: sp.alasan || undefined };
  const [stores, skus, reasons, rep] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    skuOverview(),
    prisma.returnCase.findMany({ where: { reason: { not: null } }, distinct: ["reason"], select: { reason: true }, take: 50 }),
    regionReport(f),
  ]);
  const top = f.skuKey ? await topCitiesForProduct(f.skuKey, f) : [];
  return (
    <div className="space-y-4">
      <PageHeader title="Wilayah Pembeli & Retur" subtitle="Kota/kabupaten dan provinsi pembeli · pesanan batal tidak dihitung · retur diambil dari status marketplace dan retur ERP yang tertaut" />
      <MpNav current="wilayah" />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Kanal"><select name="kanal" defaultValue={sp.kanal ?? ""} className="input"><option value="">Semua</option><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
        <Field label="Dari"><input type="date" name="dari" defaultValue={sp.dari ?? ""} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="sampai" defaultValue={sp.sampai ?? ""} className="input" /></Field>
        <Field label="Produk (SKU)"><select name="sku" defaultValue={sp.sku ?? ""} className="input"><option value="">Semua</option>{skus.map((s) => <option key={s.key} value={s.key}>{[s.sample?.sku, s.sample?.variation].filter(Boolean).join(" · ") || s.key}</option>)}</select></Field>
        <Field label="Alasan retur"><select name="alasan" defaultValue={sp.alasan ?? ""} className="input"><option value="">Semua</option>{reasons.map((r) => <option key={r.reason}>{r.reason}</option>)}</select></Field>
      </FilterBar>
      {rep.total === 0 ? <Empty title="Belum ada data" hint="Impor file pesanan dulu." /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="Pesanan (tidak batal)" value={rep.total.toLocaleString("id-ID")} />
            <Stat label="Retur" value={rep.totalRet.toLocaleString("id-ID")} tone="red" />
            <Stat label="% retur rata-rata" value={pc(rep.avgPct)} tone="amber" />
          </div>
          <Card title="Per kota/kabupaten"><RegionTable rows={rep.cities} first="Kota/Kab." /></Card>
          <Card title="Per provinsi"><RegionTable rows={rep.provinces} first="Provinsi" /></Card>
          <Card title="Kurir / opsi kirim"><RegionTable rows={rep.couriers} first="Kurir" /></Card>
          {rep.damagedProducts.length > 0 && <Card title="Produk paling sering rusak (hasil periksa retur)"><ul className="text-sm">{rep.damagedProducts.map((d) => <li key={d.key}>{d.name}: {d.qty} pcs</li>)}</ul></Card>}
          {f.skuKey && <Card title="Kota pembeli terbanyak untuk produk ini"><ul className="text-sm">{top.map((t) => <li key={t.name}>{t.name}: {t.orders} pesanan</li>)}</ul></Card>}
        </>
      )}
    </div>
  );
}
