import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { latestMonth } from "@/lib/marketplace/dashboard";
import { lostOrdersWithoutCompensation, pengeluaranReport, shipDiscrepancyReport } from "@/lib/marketplace/pengeluaran";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { BarsChart } from "@/components/Charts";
import { saveCostTargetsAction } from "../actions";
import { ImportBannerServer } from "@/components/ImportBannerServer";
import { MpNav } from "../MpNav";

export const metadata = { title: "Pengeluaran Marketplace" };
const MONTH = /^\d{4}-\d{2}$/;
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
const SRC = { ATUR: "diatur", PENGATURAN: "Produk › Biaya", RATA3: "rata-rata 3 bln +20%" } as const;

export default async function PengeluaranPage({ searchParams }: { searchParams: Promise<{ bulan?: string; toko?: string }> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const sp = await searchParams;
  const month = MONTH.test(sp.bulan ?? "") ? sp.bulan! : await latestMonth();
  const storeId = sp.toko || undefined;
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } });
  const reports = await Promise.all((["SHP", "TTS"] as const).map(async (ch) => ({ r: await pengeluaranReport({ month, storeId, channel: ch }), lost: await lostOrdersWithoutCompensation({ month, storeId, channel: ch }), disc: await shipDiscrepancyReport({ month, storeId, channel: ch }) })));
  const data = reports.filter((x) => x.r.gross > 0 || x.r.total !== 0);
  return (
    <div className="space-y-4">
      <PageHeader title="Pengeluaran Marketplace" subtitle="Semua uang keluar dari harga jual sampai rekening, per sektor · bandingkan bulan lalu · tanda OVERCOST bila melebihi target" />
      <MpNav current="pengeluaran" />
      <ImportBannerServer />
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Angka marketplace = data operasional dari file; tidak masuk jurnal. Persentase dihitung dari harga jual (gross) pesanan yang cair pada bulan itu.</p>
      <FilterBar>
        <Field label="Bulan"><input type="month" name="bulan" defaultValue={month} className="input" /></Field>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </FilterBar>
      {data.length === 0 ? <Empty title="Belum ada data penghasilan pada bulan ini" hint="Unggah file penghasilan, saldo penjual, dan saldo iklan di menu Impor." /> : data.map(({ r, lost, disc }) => (
        <Card key={r.channel} title={`${r.label} · total pengeluaran ${idr(r.total)} (${pc(r.totalPct)} dari harga jual ${idr(r.gross)})`}>
          {r.overs.length > 0 && <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"><b>OVERCOST:</b> {r.rows.filter((x) => x.over).map((x) => x.label).join(", ")}</div>}
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Sektor</th><th className="num">Rp</th><th className="num">% harga jual</th><th className="num">Bulan lalu</th><th className="num">Δ</th><th className="num">Target</th><th></th></tr></thead>
            <tbody>
              {r.rows.filter((x) => x.value !== 0 || x.prevValue !== 0).map((x) => (
                <tr key={x.key} className={x.info ? "text-slate-400" : ""}>
                  <td>{x.label}</td><td className="num">{idr(x.value)}</td><td className="num">{pc(x.pct)}</td><td className="num">{pc(x.prevPct)}</td>
                  <td className="num">{x.info ? "-" : `${x.delta > 0 ? "▲ +" : x.delta < 0 ? "▼ " : ""}${pc(x.delta)}`}</td>
                  <td className="num">{x.target === null ? "-" : <>{pc(x.target)} <span className="text-xs text-slate-400">{x.targetSource && SRC[x.targetSource]}</span></>}</td>
                  <td>{x.over && <Badge tone="red">OVERCOST</Badge>}</td>
                </tr>
              ))}
              <tr className="font-semibold"><td>Total pengeluaran</td><td className="num">{idr(r.total)}</td><td className="num">{pc(r.totalPct)}</td><td className="num">{pc(r.prevTotalPct)}</td><td className="num">{r.totalPct - r.prevTotalPct > 0 ? "▲ +" : "▼ "}{pc(r.totalPct - r.prevTotalPct)}</td><td colSpan={2}></td></tr>
            </tbody>
          </table></div>
          <div className="mt-3"><BarsChart data={r.rows.filter((x) => !x.info && (x.pct > 0 || x.prevPct > 0)).map((x) => ({ label: x.label.split(" ")[0] + (x.label.split(" ")[1] ? ` ${x.label.split(" ")[1]}` : ""), "Bulan ini %": Math.round(x.pct * 100) / 100, "Bulan lalu %": Math.round(x.prevPct * 100) / 100 }))} series={[{ key: "Bulan ini %", label: "Bulan ini", color: "#e11d48" }, { key: "Bulan lalu %", label: "Bulan lalu", color: "#94a3b8" }]} /></div>
          {lost.count > 0 && <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">{lost.count} pesanan tampak hilang tetapi belum ada kompensasi di penyesuaian (nilai {idr(lost.value)}): {lost.orders.join(", ")}{lost.count > 10 ? " …" : ""}</p>}
          {disc && (
            <div className="mt-3 rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium">Selisih ongkir (berat/dimensi/alamat): {disc.count} pesanan · selisih {idr(disc.value)}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{disc.reasons.map((x) => <li key={x.reason}>{x.reason} — {x.count} pesanan · {idr(x.value)}</li>)}</ul>
              {disc.products.length > 0 && <div className="mt-2 text-xs"><p className="font-medium text-amber-800">Produk yang sering kena selisih berat/dimensi (cek berat &amp; dimensi di master/marketplace):</p><ul className="list-disc pl-4 text-slate-600">{disc.products.map((p) => <li key={p.sku}>{p.sku}{p.name ? ` · ${p.name}` : ""} — {p.orders} pesanan</li>)}</ul></div>}
            </div>
          )}
          {canManage && (
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-brand-700">Atur target % per sektor</summary>
              <ActionForm action={saveCostTargetsAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                <input type="hidden" name="channel" value={r.channel} />
                {r.rows.filter((x) => !x.info).map((x) => <label key={x.key} className="text-xs"><span className="text-slate-500">{x.label}</span><input name={`t:${x.key}`} inputMode="decimal" defaultValue={x.targetSource === "ATUR" ? x.target ?? "" : ""} placeholder={x.target !== null ? `${x.target} (${x.targetSource && SRC[x.targetSource]})` : "-"} className="input" /></label>)}
                <div className="sm:col-span-3"><Submit className="btn-secondary">Simpan target</Submit> <span className="text-xs text-slate-500">Kosong = bawaan Produk › Biaya, atau rata-rata 3 bulan + 20%.</span></div>
              </ActionForm>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}
