import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { todayStr } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { reconcile } from "@/lib/marketplace/report";
import { integrityCheck, channelLabel } from "@/lib/marketplace/integrity";
import { PeriodFilter } from "../PeriodFilter";
import { resolvePeriod } from "@/lib/marketplace/periode";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { ImportBannerServer } from "@/components/ImportBannerServer";
import { MpNav } from "../MpNav";

export const metadata = { title: "Rekonsiliasi Marketplace" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function RekonPage({ searchParams }: { searchParams: Promise<{ toko?: string; dari?: string; sampai?: string; periode?: string; bulan?: string }> }) {
  await requirePerm("sales.view");
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const { from, to } = period;
  const [integrity, stores, rows] = await Promise.all([
    integrityCheck({ month: from.slice(0, 7), storeId: sp.toko || undefined }),prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }), reconcile({ storeId: sp.toko || undefined, from, to })]);
  return (
    <div className="space-y-4">
      <PageHeader title="Rekonsiliasi" subtitle="Uang cair (file penghasilan) dibanding withdraw yang sudah dicatat di Keuangan · hanya laporan, tidak membuat transaksi" />
      <MpNav current="rekon" />
      <ImportBannerServer />
      <PeriodFilter sp={sp} period={period} />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        {[["periode", sp.periode], ["bulan", sp.bulan], ["dari", sp.dari], ["sampai", sp.sampai]].map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      </FilterBar>
      {rows.length === 0 ? <Empty title="Belum ada data cair pada periode ini" hint="Unggah file penghasilan di menu Impor." /> : (
        <Card>
          <div className="table-wrap">
            <table className="tbl tbl-mp">
              <thead><tr><th>Toko</th><th>Kanal</th><th className="num">Pesanan cair</th><th className="num">Total cair</th><th className="num">Iklan GMV</th><th className="num">Penyesuaian</th><th className="num">Withdraw tercatat</th><th className="num">Selisih</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.storeId + r.channel}>
                    <td>{r.store}</td><td>{CHANNEL_LABEL[r.channel]}</td><td className="num">{r.orders}</td><td className="num">{idr(r.cair)}</td><td className="num">{idr(r.ads)}</td><td className="num">{idr(r.adjust)}</td><td className="num">{idr(r.recorded)}</td>
                    <td className="num">{idr(r.diff)}</td>
                    <td>{r.noBank ? <Badge tone="amber">Rekening marketplace belum ada</Badge> : r.diff === 0 ? <Badge tone="green">Cocok</Badge> : <Badge tone="amber">Selisih</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">Selisih = cair + iklan GMV + penyesuaian − withdraw tercatat. Withdraw diambil dari transfer keluar rekening saldo marketplace di Keuangan untuk toko yang sama. Riwayat penarikan TikTok di file: {rows.filter((r) => r.channel === "TTS").map((r) => idr(r.tiktokWithdraw)).join(" / ") || "-"}.</p>
        </Card>
      )}
      <Card title={`Cek integritas · ${integrity.month}${integrity.failed ? ` · ${integrity.failed} dari ${integrity.total} gagal` : integrity.total ? " · semua lolos" : ""}`}>
        {integrity.groups.length === 0 ? <p className="text-sm text-slate-500">Belum ada data pada bulan ini.</p> : (
          <div className="space-y-4">
            {integrity.groups.map((g) => (
              <div key={g.storeId + g.channel}>
                <p className="mb-1 text-sm font-semibold">{g.store} · {channelLabel(g.channel)}</p>
                <ul className="space-y-1.5 text-sm">
                  {g.checks.map((c) => (
                    <li key={c.key}>
                      <span className={c.ok ? "text-emerald-600" : c.warn ? "font-semibold text-amber-600" : "font-semibold text-rose-600"}>{c.ok ? "✓" : c.warn ? "⚠" : "✗"}</span> <span className="font-medium">{c.label}</span> <span className="text-slate-500">— {c.detail}</span>
                      {!c.ok && c.items?.length ? <ul className="ml-5 mt-0.5 list-disc text-xs text-slate-600">{c.items.slice(0, 8).map((it) => <li key={it}>{it}</li>)}</ul> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-medium">Omzet marketplace ↔ pendapatan Akuntansi (berdampingan, tidak dijumlahkan)</p>
          <div className="mt-1 grid grid-cols-2 gap-2"><div><span className="text-xs text-slate-500">Omzet pesanan bulan ini (file)</span><p className="text-lg font-semibold tabular-nums">{idr(integrity.accounting.omzet)}</p><p className="text-xs text-slate-500">{integrity.accounting.orders} pesanan</p></div><div><span className="text-xs text-slate-500">Pendapatan dibukukan dari withdraw</span><p className="text-lg font-semibold tabular-nums">{idr(integrity.accounting.booked)}</p></div></div>
          <p className="mt-2 text-xs text-slate-500">{integrity.accounting.note}</p>
        </div>
        <p className="mt-2 text-xs text-slate-500">Juga bisa dijalankan lewat terminal: <code>npm run marketplace:cek -- --bulan={integrity.month}</code></p>
      </Card>
    </div>
  );
}
