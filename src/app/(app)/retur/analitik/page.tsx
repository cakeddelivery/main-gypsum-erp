import { requirePerm } from "@/lib/auth";
import { idr } from "@/lib/money";
import { fmtDate, jakartaDateTime, jakartaParts } from "@/lib/time";
import { analyze, loadReturnAnalytics, lossOf, monthKey, monthsBetween, type GroupRow } from "@/lib/returnAnalytics";
import { marketplaceLabel } from "@/lib/returnLabel";
import { Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { BarsChart, TrendChart } from "@/components/Charts";
import { ReturTabs } from "../ReturTabs";

export const metadata = { title: "Analitik Retur & Komplain" };

type SP = { dari?: string; sampai?: string };
const MONTH = /^\d{4}-\d{2}$/;
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const monthLabel = (m: string) => `${BULAN[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
const pct = (v: number | null) => (v === null ? "-" : `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`);

function GroupTable({ title, rows, file, first }: { title: string; rows: GroupRow[]; file: string; first: string }) {
  return (
    <Card title={title} actions={<DownloadCsv filename={file} label="Unduh" rows={[[first, "Retur", "Komplain", "Qty barang", "Qty bermasalah", "Kerugian (Rp)"], ...rows.map((r) => [r.label, r.returns, r.complaints, r.qty, r.bad, r.loss])]} />}>
      {rows.length === 0 ? <p className="text-sm text-slate-500">Belum ada data.</p> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>{first}</th><th className="num">Retur</th><th className="num">Komplain</th><th className="num">Bermasalah</th><th className="num">Kerugian</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.returns}</td><td className="num">{r.complaints}</td><td className="num">{r.bad.toLocaleString("id-ID")}</td><td className="num">{idr(r.loss)}</td></tr>)}</tbody>
          </table></Paged>
        </div>
      )}
    </Card>
  );
}

export default async function AnalitikRetur({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("accounting.view", "retur.manage", "refund.approve");
  const sp = await searchParams;
  const now = jakartaParts();
  const cur = `${now.year}-${String(now.month).padStart(2, "0")}`;
  const back = new Date(Date.UTC(now.year, now.month - 1 - 5, 1));
  const def = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}`;
  let from = sp.dari && MONTH.test(sp.dari) ? sp.dari : def;
  let to = sp.sampai && MONTH.test(sp.sampai) ? sp.sampai : cur;
  if (from > to) [from, to] = [to, from];
  const months = monthsBetween(from, to);
  const last = months[months.length - 1];
  const [ly, lm] = last.split("-").map(Number);
  const start = jakartaDateTime(`${from}-01`, "00:00");
  const end = jakartaDateTime(`${lm === 12 ? ly + 1 : ly}-${String(lm === 12 ? 1 : lm + 1).padStart(2, "0")}-01`, "00:00");
  const { events, salesByMonth } = await loadReturnAnalytics(start, end);
  const a = analyze(events, salesByMonth, months);
  const t = a.totals;
  const sorted = [...events].sort((x, y) => y.date.getTime() - x.date.getTime());
  const file = (s: string) => `analitik-retur-${s}-${from}-${to}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analitik Retur & Komplain"
        subtitle="Kerugian = barang retur rusak/tidak ada + refund dibayar + barang pengganti + ongkir ditanggung toko. Rasio dibanding penjualan (akun 4-1000 + 4-1100) di periode yang sama."
        actions={<DownloadCsv filename={file("detail")} label="Unduh detail" rows={[["Jenis", "No.", "Tanggal", "Bulan", "Marketplace", "Kurir", "Kota/Kab", "Provinsi", "Alasan/masalah", "Barang", "Barang rusak/pengganti (Rp)", "Refund (Rp)", "Ongkir (Rp)", "Kerugian (Rp)", "Klaim cair (Rp)"], ...sorted.map((e) => [e.kind === "RETUR" ? "Retur" : "Komplain", e.number, fmtDate(e.date), monthKey(e.date), marketplaceLabel(e.marketplace), e.courier ?? "", e.city ?? "", e.province ?? "", e.reason, e.lines.map((l) => `${l.itemName ?? [l.sku, l.variation].filter(Boolean).join(" ")} × ${l.qty}${l.bad && l.bad !== l.qty ? ` (bermasalah ${l.bad})` : ""}`).join("; "), e.goods, e.refund, e.shipping, lossOf(e), e.claim])]} />}
      />
      <ReturTabs current="analitik" can={user.can} />
      <FilterBar>
        <Field label="Dari bulan"><input type="month" name="dari" defaultValue={from} className="input" /></Field>
        <Field label="Sampai bulan"><input type="month" name="sampai" defaultValue={to} className="input" /></Field>
      </FilterBar>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Retur · komplain" value={`${t.returns} · ${t.complaints}`} hint={`${months.length} bulan`} />
        <Stat label="Total kerugian" value={idr(t.loss)} hint={`Barang ${idr(t.goods)} · refund ${idr(t.refund)} · ongkir ${idr(t.shipping)}`} tone="red" />
        <Stat label="Kerugian bersih" value={idr(t.net)} hint={`setelah klaim cair ${idr(t.claim)}`} tone="amber" />
        <Stat label="Rasio thd penjualan" value={pct(t.ratio)} hint={`penjualan ${idr(t.sales)}`} tone={t.ratio !== null && t.ratio >= 2 ? "red" : "green"} />
      </div>
      {events.length === 0 ? <Empty title="Belum ada retur/komplain di periode ini" hint="Ubah rentang bulan." /> : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Kerugian per bulan">
              <BarsChart data={a.monthly.map((m) => ({ label: monthLabel(m.month), barang: m.goods, refund: m.refund, ongkir: m.shipping, klaim: m.claim }))} series={[{ key: "barang", label: "Barang", color: "#e11d48" }, { key: "refund", label: "Refund", color: "#f59e0b" }, { key: "ongkir", label: "Ongkir", color: "#64748b" }, { key: "klaim", label: "Klaim cair", color: "#10b981" }]} />
            </Card>
            <Card title="Jumlah retur & komplain per bulan">
              <TrendChart data={a.monthly.map((m) => ({ label: monthLabel(m.month), retur: m.returns, komplain: m.complaints }))} series={[{ key: "retur", label: "Retur", color: "#2563eb" }, { key: "komplain", label: "Komplain", color: "#f59e0b" }]} />
            </Card>
          </div>
          <Card title="Tren bulanan" actions={<DownloadCsv filename={file("bulanan")} label="Unduh" rows={[["Bulan", "Retur", "Komplain", "Barang (Rp)", "Refund (Rp)", "Ongkir (Rp)", "Kerugian (Rp)", "Klaim cair (Rp)", "Penjualan (Rp)", "Rasio (%)"], ...a.monthly.map((m) => [m.month, m.returns, m.complaints, m.goods, m.refund, m.shipping, m.loss, m.claim, m.sales, m.ratio ?? ""])]} />}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Bulan</th><th className="num">Retur</th><th className="num">Komplain</th><th className="num">Kerugian</th><th className="num">Klaim cair</th><th className="num">Penjualan</th><th className="num">Rasio</th></tr></thead>
                <tbody>{a.monthly.map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="num">{m.returns}</td><td className="num">{m.complaints}</td><td className="num">{idr(m.loss)}</td><td className="num">{idr(m.claim)}</td><td className="num">{idr(m.sales)}</td><td className="num">{pct(m.ratio)}</td></tr>)}</tbody>
              </table>
            </div>
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <GroupTable title="Per produk" rows={a.byProduct} file={file("produk")} first="Produk" />
            <GroupTable title="Per SKU & variasi (label)" rows={a.bySku} file={file("sku")} first="SKU · variasi" />
            <GroupTable title="Per provinsi" rows={a.byProvince} file={file("provinsi")} first="Provinsi" />
            <GroupTable title="Per kota / kabupaten" rows={a.byCity} file={file("kota")} first="Kota/Kab" />
            <GroupTable title="Per kurir" rows={a.byCourier} file={file("kurir")} first="Kurir" />
            <GroupTable title="Per marketplace" rows={a.byMarketplace} file={file("marketplace")} first="Marketplace" />
            <GroupTable title="Per alasan / jenis masalah" rows={a.byReason} file={file("alasan")} first="Alasan" />
          </div>
        </>
      )}
    </div>
  );
}
