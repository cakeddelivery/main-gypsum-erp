import { requirePerm } from "@/lib/auth";
import { idr } from "@/lib/money";
import { productProfit, rejectBreakdown } from "@/lib/productProfit";
import { CHANNEL_LABEL } from "@/lib/pricing";
import { STAGE_LABEL } from "@/lib/stock";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { parseRange, ReportFilter, type SP } from "../../akuntansi/shared";
import { ProdukTabs } from "../ProdukTabs";

export const metadata = { title: "Laba & Reject per Produk" };

const pct = (v: number) => `${v.toLocaleString("id-ID")}%`;
const rp = (v: number | null) => (v == null ? "—" : idr(v));
const tone = (v: number | null) => (v == null ? "" : v < 0 ? "text-rose-600" : "");

export default async function LabaProdukPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("product.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const channel = sp.channel && CHANNEL_LABEL[sp.channel] ? sp.channel : "OFFLINE";
  const [{ rows, channels }, rj] = await Promise.all([productProfit(r, channel), rejectBreakdown(r)]);
  const sum = (k: "qtyDone" | "qtyReject" | "rejectLoss") => rows.reduce((s, x) => s + x[k], 0);
  const priced = rows.filter((x) => x.profit != null);
  const profit = priced.reduce((s, x) => s + (x.profit ?? 0), 0);
  const loss = sum("rejectLoss");
  const missing = rows.length - priced.length;
  const ch = CHANNEL_LABEL[channel] ?? channel;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Produk & HPP"
        subtitle="Perkiraan laba per produk dari harga jual di resep × hasil produksi, dan rugi karena reject"
        actions={
          <DownloadCsv
            filename={`laba-reject-${channel.toLowerCase()}-${r.from}-${r.to}`}
            rows={[
              [`Perkiraan laba per produk (${ch}) ${r.from} s/d ${r.to}`],
              ["Perkiraan: menganggap semua hasil jadi terjual dengan harga resep kanal ini."],
              [],
              ["SKU", "Produk", "Jadi (pcs)", "Tahap dihitung", "Reject (pcs)", "Reject %", "HPP/pcs", "Harga jual", "Laba/pcs", "Perkiraan laba", "Rugi reject", "Laba setelah reject"],
              ...rows.map((x) => [x.sku, x.name, x.qtyDone, STAGE_LABEL[x.doneStage], x.qtyReject, x.rejectRate, x.hpp, x.price, x.profitUnit, x.profit, x.rejectLoss, x.net]),
              ["", "Total", sum("qtyDone"), "", sum("qtyReject"), "", "", "", "", profit, loss, profit - loss],
              [],
              ["Reject per penyebab", "Pcs"],
              ...rj.reason.map((x) => [x.label, x.reject]),
              [],
              ["Reject per tahap", "Hasil baik", "Reject", "Reject %"],
              ...rj.stage.map((x) => [STAGE_LABEL[x.stage], x.good, x.reject, x.rate]),
              [],
              ["Reject per karyawan", "Hasil baik", "Reject", "Reject %"],
              ...rj.employee.map((x) => [x.label, x.good, x.reject, x.rate]),
              [],
              ["Reject per divisi", "Hasil baik", "Reject", "Reject %"],
              ...rj.division.map((x) => [x.label, x.good, x.reject, x.rate]),
            ]}
          />
        }
      />
      <ProdukTabs current="laba" />
      <ReportFilter
        sp={sp}
        extra={
          <Field label="Harga kanal">
            <select name="channel" defaultValue={channel} className="input">{channels.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>)}</select>
          </Field>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Hasil jadi" value={`${sum("qtyDone").toLocaleString("id-ID")} pcs`} hint={`${rows.length} produk`} />
        <Stat label="Perkiraan laba" value={idr(profit)} tone={profit < 0 ? "red" : "green"} hint={`Harga ${ch}`} />
        <Stat label="Rugi reject" value={idr(loss)} tone={loss ? "red" : "slate"} hint={`${sum("qtyReject").toLocaleString("id-ID")} pcs reject`} />
        <Stat label="Laba setelah reject" value={idr(profit - loss)} tone={profit - loss < 0 ? "red" : "green"} />
      </div>
      <p className="text-xs text-slate-500">
        Angka ini <b>perkiraan</b>: menganggap semua hasil jadi terjual dengan harga {ch} yang tercatat di resep, setelah potongan marketplace, affiliate, dan iklan.
        Rugi reject = jumlah reject × nilai bahan per pcs.{missing > 0 && <> <b className="text-amber-600">{missing} produk belum punya harga {ch}</b>, isi di halaman produknya.</>}
      </p>

      {rows.length === 0 ? (
        <Empty title="Belum ada hasil produksi pada periode ini" hint="Laba per produk dihitung dari hasil produksi yang dicatat di menu Produksi." />
      ) : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Produk</th><th className="num">Jadi</th><th className="num">Reject</th><th className="num">HPP/pcs</th><th className="num">Harga</th><th className="num">Laba/pcs</th><th className="num">Perkiraan laba</th><th className="num">Rugi reject</th><th className="num">Setelah reject</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.productId}>
                  <td><a href={`/produk/${x.productId}`} className="font-medium hover:underline">{x.name}</a><div className="text-xs text-slate-400">{x.sku}{x.doneStage !== "BARANG_JADI" && ` · dihitung dari tahap ${STAGE_LABEL[x.doneStage]}`}</div></td>
                  <td className="num">{x.qtyDone.toLocaleString("id-ID")}</td>
                  <td className="num text-rose-600">{x.qtyReject.toLocaleString("id-ID")}<div className="text-[11px] text-slate-400">{pct(x.rejectRate)}</div></td>
                  <td className="num">{idr(x.hpp)}</td>
                  <td className="num">{x.price == null ? <Badge tone="amber">belum ada</Badge> : idr(x.price)}</td>
                  <td className={`num ${tone(x.profitUnit)}`}>{rp(x.profitUnit)}</td>
                  <td className={`num ${tone(x.profit)}`}>{rp(x.profit)}</td>
                  <td className="num text-rose-600">{x.rejectLoss ? idr(x.rejectLoss) : "—"}</td>
                  <td className={`num font-semibold ${tone(x.net)}`}>{rp(x.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-slate-50 font-semibold"><td>Total</td><td className="num">{sum("qtyDone").toLocaleString("id-ID")}</td><td className="num text-rose-600">{sum("qtyReject").toLocaleString("id-ID")}</td><td colSpan={3} /><td className="num">{idr(profit)}</td><td className="num text-rose-600">{idr(loss)}</td><td className="num">{idr(profit - loss)}</td></tr></tfoot>
          </table></Paged>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Reject per penyebab">
          {rj.reason.length === 0 ? <p className="text-sm text-slate-400">Tidak ada reject</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {rj.reason.map((x) => <li key={x.label} className="flex justify-between py-1.5"><span>{x.label}</span><span className="tabular-nums text-rose-600">{x.reject.toLocaleString("id-ID")} pcs</span></li>)}
            </ul>
          )}
        </Card>
        <Card title="Reject per tahap">
          {rj.stage.length === 0 ? <p className="text-sm text-slate-400">Tidak ada data</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {rj.stage.map((x) => <li key={x.stage} className="flex justify-between py-1.5"><span>{STAGE_LABEL[x.stage]}</span><span className="tabular-nums"><span className="text-rose-600">{x.reject.toLocaleString("id-ID")}</span> <span className="text-slate-400">({pct(x.rate)})</span></span></li>)}
            </ul>
          )}
        </Card>
        <Card title="Reject per karyawan (tertinggi)">
          {rj.employee.length === 0 ? <p className="text-sm text-slate-400">Tidak ada reject</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {rj.employee.slice(0, 10).map((x) => <li key={x.label} className="flex justify-between py-1.5"><span>{x.label}</span><span className="tabular-nums"><span className="text-rose-600">{x.reject.toLocaleString("id-ID")}</span> <span className="text-slate-400">({pct(x.rate)})</span></span></li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
