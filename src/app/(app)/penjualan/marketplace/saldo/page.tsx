import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { bookBalance, matchWithdrawals, saldoPanel, wdReminderHour } from "@/lib/marketplace/saldo";
import { PeriodFilter } from "../PeriodFilter";
import { resolvePeriod } from "@/lib/marketplace/periode";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveWdHourAction } from "../actions";
import { MpNav } from "../MpNav";

export const metadata = { title: "Saldo Marketplace" };
const TONE = { COCOK: "green", BELUM_DI_ERP: "amber", TIDAK_DI_FILE: "red" } as const;
const LABEL = { COCOK: "Cocok", BELUM_DI_ERP: "Belum tercatat di ERP", TIDAK_DI_FILE: "Tercatat, tidak ada di file" } as const;

export default async function SaldoPage({ searchParams }: { searchParams: Promise<{ toko?: string; dari?: string; sampai?: string; periode?: string; bulan?: string }> }) {
  const user = await requirePerm("sales.view");
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const { from, to } = period;
  const [stores, rows, hour] = await Promise.all([prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }), saldoPanel({ storeId: sp.toko || undefined }), wdReminderHour()]);
  const books = (await Promise.all(stores.filter((x) => !sp.toko || x.id === sp.toko).map(async (x) => ({ store: x.name, b: await bookBalance(x.id, "SHP") })))).filter((x) => x.b);
  const pairs = [...new Map(rows.map((r) => [`${r.storeId}|${r.channel}`, r])).values()];
  const matches = (await Promise.all(pairs.map(async (r) => ({ key: r.storeId + r.channel, name: `${r.store} · ${CHANNEL_LABEL[r.channel]}`, list: await matchWithdrawals({ storeId: r.storeId, channel: r.channel as "SHP" | "TTS", from, to }) })))).filter((m) => m.list.length);
  return (
    <div className="space-y-4">
      <PageHeader title="Saldo Marketplace" subtitle="Cair (impor) − potongan iklan − withdraw tercatat di Keuangan = saldo belum ditarik · hanya laporan" actions={<Link href="/finance" className="btn-secondary">Keuangan</Link>} />
      <MpNav current="saldo" />
      <PeriodFilter sp={sp} period={period} />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        {[["periode", sp.periode], ["bulan", sp.bulan], ["dari", sp.dari], ["sampai", sp.sampai]].map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      </FilterBar>
      {rows.length === 0 ? <Empty title="Belum ada data cair" hint="Unggah file penghasilan di menu Impor." /> : (
        <Card title="Saldo berjalan (sejak data pertama)">
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Toko</th><th>Kanal</th><th className="num">Cair bersih</th><th className="num">Withdraw tercatat</th><th className="num">Belum ditarik</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.storeId + r.channel}>
                <td>{r.store}</td><td>{CHANNEL_LABEL[r.channel]}</td><td className="num">{idr(r.cair)}</td><td className="num">{idr(r.recorded)}</td><td className="num font-medium">{idr(r.estimate)}</td>
                <td>
                  {r.status === "KOSONG" ? <Badge tone="gray">Sudah ditarik</Badge> : r.status === "NORMAL" ? <Badge tone="green">Normal · dari hari ini</Badge> : r.status === "PERINGATAN" ? <Badge tone="amber">Peringatan · sejak {r.since} ({r.ageDays} hari)</Badge> : <Badge tone="red">Merah · sejak {r.since} ({r.ageDays} hari)</Badge>}
                  {r.todayCount > 0 && <div className="text-xs text-slate-500">Hari ini: {r.todayCount} withdraw · {idr(r.todayAmount)}</div>}
                  {r.coverage.slice(0, 3).map((c) => <div key={c.date + c.amount} className="text-xs text-slate-500">Withdraw {c.date} ({idr(c.amount)}) {c.covers ? `menutup cair ${c.covers.from === c.covers.to ? c.covers.from : `${c.covers.from} s/d ${c.covers.to}`}` : "belum ada cair yang ditutup"}</div>)}
                  {r.over > 0 && <div className="text-xs text-rose-700">Withdraw melebihi cair yang diketahui Rp {r.over.toLocaleString("id-ID")} — unggah file penghasilan yang belum masuk, atau cek nominal withdraw.</div>}
                  {r.notInErp > 0 && <div className="text-xs text-amber-700">{r.notInErp} penarikan di file (Rp {r.notInErpAmount.toLocaleString("id-ID")}) belum tercatat di Keuangan; tetap dihitung mengurangi saldo.</div>}
                  {r.noBank && <div className="text-xs text-amber-700">Rekening saldo marketplace belum ada di Keuangan</div>}
                </td>
              </tr>))}</tbody>
          </table></div>
          <p className="mt-2 text-xs text-slate-500">Withdraw boleh digabung beberapa hari: tiap withdraw menutup cair yang paling lama lebih dulu. Normal = saldo hanya dari hari ini · Peringatan = ada cair 1–3 hari belum ditarik · Merah = lebih dari 3 hari. Withdraw dicatat di Keuangan seperti biasa; halaman ini tidak membuat transaksi.</p>
        </Card>
      )}
      {books.length > 0 && (
        <Card title="Saldo menurut Shopee vs estimasi ERP">
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Toko</th><th>Per tanggal</th><th className="num">Saldo menurut Shopee</th><th className="num">Estimasi ERP</th><th className="num">Selisih</th></tr></thead>
            <tbody>{books.map(({ store, b }) => <tr key={store}><td>{store}</td><td>{b!.asOf}</td><td className="num">{idr(b!.shopee)}</td><td className="num">{idr(b!.erp)}</td><td className="num">{Math.abs(b!.diff) <= 1 ? <Badge tone="green">Sama</Badge> : <Badge tone="red">{idr(b!.diff)}</Badge>}</td></tr>)}</tbody>
          </table></div>
          <p className="mt-2 text-xs text-slate-500">Dari file “Transaksi Saldo Penjual” (Saldo Akhir baris terbaru). Estimasi ERP = saldo awal periode + cair + penyesuaian − isi saldo iklan − withdraw. Selisih berarti ada file penghasilan/withdraw yang belum diimpor.</p>
        </Card>
      )}
      {matches.map((m) => (
        <Card key={m.key} title={`Penarikan di file vs Keuangan · ${m.name}`}>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Referensi</th><th>Tanggal</th><th className="num">Di file</th><th className="num">Di ERP</th><th>Status</th></tr></thead>
            <tbody>{m.list.map((w) => <tr key={w.refId + w.status}><td className="font-mono text-xs">{w.refId}</td><td>{fmtDateTime(w.date)}</td><td className="num">{w.fileAmount === null ? "-" : idr(w.fileAmount)}</td><td className="num">{w.erpAmount === null ? "-" : idr(w.erpAmount)}</td><td><Badge tone={TONE[w.status]}>{LABEL[w.status]}</Badge></td></tr>)}</tbody>
          </table></div>
        </Card>
      ))}
      {user.can("sales.manage") && (
        <Card title="Pengingat harian">
          <ActionForm action={saveWdHourAction} className="flex flex-wrap items-end gap-2">
            <Field label="Kirim pengingat ke Finance & Owner pukul"><input name="hour" type="number" min={0} max={23} defaultValue={hour} className="input w-24" /></Field>
            <Submit className="btn-secondary">Simpan</Submit>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-500">Dikirim bila ada toko/kanal dengan saldo belum ditarik tetapi belum ada withdraw tercatat hari itu.</p>
        </Card>
      )}
    </div>
  );
}
