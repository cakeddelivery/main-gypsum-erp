import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { bookBalance, matchWithdrawals, saldoPanel, wdReminderHour, wdSummary } from "@/lib/marketplace/saldo";
import { PeriodFilter } from "../PeriodFilter";
import { resolvePeriod } from "@/lib/marketplace/periode";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveWalletCheckAction, saveWdHourAction } from "../actions";
import { todayStr } from "@/lib/time";
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
  const matches = (await Promise.all(pairs.map(async (r) => ({ key: r.storeId + r.channel, storeId: r.storeId, channel: r.channel, name: `${r.store} · ${CHANNEL_LABEL[r.channel]}`, list: await matchWithdrawals({ storeId: r.storeId, channel: r.channel as "SHP" | "TTS", from, to }) })))).filter((m) => m.list.length);
  return (
    <div className="space-y-4">
      <PageHeader title="Saldo Marketplace" subtitle="Cair (impor) − potongan iklan − withdraw tercatat di Keuangan = saldo belum ditarik · hanya laporan" actions={<Link href="/finance" className="btn-secondary">Keuangan</Link>} />
      <MpNav current="saldo" />
      <PeriodFilter sp={sp} period={period} />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        {[["periode", sp.periode], ["bulan", sp.bulan], ["dari", sp.dari], ["sampai", sp.sampai]].map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      </FilterBar>
      {rows.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((r) => {
            const w = r.wallet;
            const m = matches.find((x) => x.key === r.storeId + r.channel);
            const sm = m ? wdSummary(m.list) : null;
            const miss = sm?.recent ?? [];
            return (
              <div key={"top" + r.storeId + r.channel} className="card space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="font-semibold">{r.store} · {CHANNEL_LABEL[r.channel]}</p>
                  <p className="text-xl font-bold tabular-nums">{idr(w.balance)}</p>
                </div>
                <p className="text-xs text-slate-500">{w.basis === "ACUAN" ? `Dari acuan ${w.official!.asOf}${w.official!.at ? ` ${w.official!.at} WIB` : ""} (${w.official!.source === "FILE" ? "Saldo Akhir file" : "isian"}) + mutasi sesudahnya` : "Estimasi dari data impor — belum ada acuan Seller Center"}{w.diff !== null && (Math.abs(w.diff) <= 1 ? <> · <Badge tone="green">Sama dengan acuan</Badge></> : <> · selisih acuan − estimasi <b className="text-rose-700">{idr(w.diff)}</b></>)}</p>
                {r.channel === "TTS" && w.transit.count > 0 && <p className="text-xs text-amber-800">Dana dalam perjalanan: {idr(w.transit.amount)} ({w.transit.count} withdraw)</p>}
                {user.can("sales.manage") && (
                  <ActionForm action={saveWalletCheckAction} className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap sm:items-end">
                    <input type="hidden" name="storeId" value={r.storeId} /><input type="hidden" name="channel" value={r.channel} />
                    <Field label="Saldo menurut Seller Center"><input name="amount" inputMode="numeric" className="input w-full sm:w-40" placeholder="mis. 423.381" required /></Field>
                    <Field label="Tanggal"><input type="date" name="asOf" defaultValue={todayStr()} max={todayStr()} className="input w-full sm:w-auto" /></Field>
                    <Field label="Jam WIB" hint="kosong = sekarang"><input type="time" name="time" className="input w-full sm:w-28" /></Field>
                    <Submit className="btn-secondary w-full sm:w-auto" pendingText="…">Simpan acuan</Submit>
                  </ActionForm>
                )}
                <div className="border-t pt-3 text-sm">
                  <p>Withdraw di file <b>{sm?.inFile ?? 0}</b> · tercatat di Keuangan <b>{sm?.ok ?? 0}</b> · belum tercatat <b className={miss.length ? "text-amber-700" : ""}>{miss.length}</b>{miss.length > 0 && <> ({idr(sm!.recentSum)})</>}</p>
                  {sm && sm.before.length > 0 && <p className="mt-1 text-xs text-slate-500">+ {sm.before.length} penarikan ({idr(sm.beforeSum)}) di file sebelum {sm.firstDay} — sebelum pencatatan withdraw di Keuangan dimulai; tetap dikurangkan dari saldo, tidak perlu dicatat.</p>}
                  {miss.length > 0 && <a href={`#wd-${r.storeId}${r.channel}`} className="btn-secondary mt-2 inline-block w-full text-center sm:w-auto">Lihat & catat yang belum tercatat</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 0 && (
        <Card title="Rincian hitungan saldo per toko × kanal">
          <div className="space-y-3">
            {rows.map((r) => {
              const w = r.wallet;
              const line = (label: string, v: number, sign: "+" | "−" | "=") => <tr key={label}><td className="text-slate-600">{sign} {label}</td><td className="num">{idr(v)}</td></tr>;
              return (
                <div key={r.storeId + r.channel} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">{r.store} · {CHANNEL_LABEL[r.channel]}</p>
                    <p className="text-sm">Saldo (kartu dashboard): <b className="tabular-nums">{idr(w.balance)}</b> <span className="text-xs text-slate-500">{w.basis === "ACUAN" ? `dari acuan ${w.official!.asOf} (${w.official!.source === "FILE" ? "Saldo Akhir file Saldo Penjual" : "isian Finance"}) + mutasi sesudahnya` : "estimasi dari data impor (belum ada acuan)"}</span></p>
                  </div>
                  <div className="mt-2 grid gap-4 lg:grid-cols-2">
                    <div className="table-wrap"><table className="tbl tbl-mp">
                      <tbody>
                        {line(`Saldo awal (${w.opening.source === "FILE" ? `file Saldo Penjual, ${w.opening.from}` : "tidak diketahui, dianggap 0"})`, w.opening.amount, "+")}
                        {line("Cair pesanan", w.cair, "+")}
                        {line("Penyesuaian", w.adjust, "+")}
                        {line("Top-up saldo iklan", w.topup, "+")}
                        {line("Potongan GMV Pay", w.gmv, "+")}
                        {line(`Withdraw (${w.notInErp.count ? "file" : "file / Keuangan"})`, -w.withdraw, "+")}
                        <tr className="font-semibold"><td>= Estimasi ERP (sejak awal data)</td><td className="num">{idr(w.estimate)}</td></tr>
                        {r.channel === "TTS" && <tr className="text-amber-800"><td>↳ Dana dalam perjalanan (withdraw diminta, belum masuk rekening; {w.transit.count} withdraw)</td><td className="num">{idr(w.transit.amount)}</td></tr>}
                      </tbody>
                    </table></div>
                    <div className="space-y-1 text-sm">
                      <p>Saldo menurut marketplace: <b>{w.official ? idr(w.official.amount) : "belum ada acuan"}</b>{w.official && <span className="text-xs text-slate-500"> per {w.official.asOf}{w.official.at ? ` pukul ${w.official.at} WIB` : ""} ({w.official.source === "FILE" ? "Saldo Akhir file" : `isian${w.official.note ? `: ${w.official.note}` : ""}`})</span>}</p>
                      {w.diff !== null && <p>Selisih acuan − estimasi: {Math.abs(w.diff) <= 1 ? <Badge tone="green">Sama</Badge> : <b className="text-rose-700">{idr(w.diff)}</b>}</p>}
                      {w.causes.length > 0 && <ul className="list-disc pl-4 text-xs text-amber-800">{w.causes.map((c) => <li key={c}>{c}</li>)}</ul>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">Satu sumber withdraw per tanggal: bila file penarikan ada untuk tanggal itu, file yang dipakai dan Keuangan hanya dicocokkan; withdraw Keuangan tanpa padanan di file tidak dikurangkan lagi (jadi peringatan). Shopee memakai Saldo Akhir baris terbaru file Saldo Penjual sebagai angka resmi; TikTok tidak punya saldo berjalan, isi saldo Seller Center sebagai acuan.</p>
        </Card>
      )}
      {rows.length === 0 ? <Empty title="Belum ada data cair" hint="Unggah file penghasilan di menu Impor." /> : (
        <Card title="Saldo berjalan (sejak data pertama)">
          <div className="grid gap-3 lg:grid-cols-2">{rows.map((r) => (
            <div key={r.storeId + r.channel} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><b>{r.store} · {CHANNEL_LABEL[r.channel]}</b><b className="tabular-nums">{idr(r.wallet.balance)}</b></div>
              <div className="mt-1 text-xs text-slate-500">Cair bersih {idr(r.wallet.cair)} · Withdraw (satu sumber) {idr(r.wallet.withdraw)} · belum ditarik sesuai tanggal: {idr(r.estimate)}</div>
              <div className="mt-2">
                {r.status === "KOSONG" ? <Badge tone="gray">Sudah ditarik</Badge> : r.status === "NORMAL" ? <Badge tone="green">Normal · dari hari ini</Badge> : r.status === "PERINGATAN" ? <Badge tone="amber">Peringatan · sejak {r.since} ({r.ageDays} hari)</Badge> : <Badge tone="red">Merah · sejak {r.since} ({r.ageDays} hari)</Badge>}
              </div>
              {r.todayCount > 0 && <div className="text-xs text-slate-500">Hari ini: {r.todayCount} withdraw · {idr(r.todayAmount)}</div>}
              {r.coverage.slice(0, 3).map((c) => <div key={c.date + c.amount} className="text-xs text-slate-500">Withdraw {c.date} ({idr(c.amount)}) {c.covers ? `menutup cair ${c.covers.from === c.covers.to ? c.covers.from : `${c.covers.from} s/d ${c.covers.to}`}` : "belum ada cair yang ditutup"}</div>)}
              {r.over > 0 && <div className="text-xs text-rose-700">Withdraw melebihi cair yang diketahui Rp {r.over.toLocaleString("id-ID")} — unggah file penghasilan yang belum masuk, atau cek nominal withdraw.</div>}
              {r.notInErp > 0 && <div className="text-xs text-amber-700">{r.notInErp} penarikan di file (Rp {r.notInErpAmount.toLocaleString("id-ID")}) belum tercatat di Keuangan; tetap dihitung mengurangi saldo.</div>}
              {r.noBank && <div className="text-xs text-amber-700">Rekening saldo marketplace belum ada di Keuangan</div>}
            </div>))}</div>
          <p className="mt-2 text-xs text-slate-500">Angka utama = saldo dari satu fungsi (saldo awal + acuan + satu sumber withdraw), sama dengan dashboard Penjualan. “Belum ditarik sesuai tanggal” hanya untuk status umur saldo (FIFO). Normal = saldo hanya dari hari ini · Peringatan = ada cair 1–3 hari belum ditarik · Merah = lebih dari 3 hari.</p>
        </Card>
      )}
      {books.length > 0 && (
        <Card title="Saldo menurut Shopee vs estimasi ERP">
          <div className="grid gap-2 sm:grid-cols-2">{books.map(({ store, b }) => <div key={store} className="rounded-lg border border-slate-200 p-3 text-sm"><b>{store}</b> <span className="text-xs text-slate-500">per {b!.asOf}</span><div className="mt-1 flex justify-between"><span>Saldo menurut Shopee</span><b className="tabular-nums">{idr(b!.shopee)}</b></div><div className="flex justify-between"><span>Estimasi ERP</span><span className="tabular-nums">{idr(b!.erp)}</span></div><div className="flex justify-between"><span>Selisih</span>{Math.abs(b!.diff) <= 1 ? <Badge tone="green">Sama</Badge> : <Badge tone="red">{idr(b!.diff)}</Badge>}</div></div>)}</div>
          <p className="mt-2 text-xs text-slate-500">Dari file “Transaksi Saldo Penjual” (Saldo Akhir baris terbaru). Selisih berarti ada file penghasilan/withdraw yang belum diimpor.</p>
        </Card>
      )}
      {matches.map((m) => {
        const sm = wdSummary(m.list);
        const inFile = m.list.filter((w) => w.fileAmount !== null), ok = m.list.filter((w) => w.status === "COCOK"), missing = m.list.filter((w) => w.status === "BELUM_DI_ERP"), extra = m.list.filter((w) => w.status === "TIDAK_DI_FILE");
        const sum = (l: typeof m.list) => l.reduce((a, w) => a + (w.fileAmount ?? w.erpAmount ?? 0), 0);
        const wib = (d: Date | null) => (d ? new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10) : "");
        return (
        <div key={m.key} id={`wd-${m.key}`}><Card title={`Penarikan di file vs Keuangan · ${m.name}`}>
          <p className="mb-2 text-sm">Withdraw di file <b>{inFile.length}</b> ({idr(sum(inFile))}) · tercatat di ERP <b>{ok.length}</b> ({idr(sum(ok))}) · belum tercatat <b className={missing.length ? "text-amber-700" : ""}>{missing.length}</b> ({idr(sum(missing))}){extra.length > 0 && <> · tercatat tanpa padanan di file <b className="text-rose-700">{extra.length}</b> ({idr(sum(extra))})</>}</p>
          <div className="table-wrap"><table className="tbl tbl-mp">
            <thead><tr><th>Referensi</th><th>Tanggal</th><th className="num">Di file</th><th className="num">Di ERP</th><th>Status</th><th></th></tr></thead>
            <tbody>{m.list.map((w) => <tr key={w.refId + w.status + (w.txId ?? "")}><td className="font-mono text-xs">{w.refId}</td><td>{fmtDateTime(w.date)}</td><td className="num">{w.fileAmount === null ? "-" : idr(w.fileAmount)}</td><td className="num">{w.erpAmount === null ? "-" : idr(w.erpAmount)}</td><td>{w.status === "BELUM_DI_ERP" && sm.isBefore(w) ? <Badge tone="gray">Sebelum pencatatan Keuangan dimulai</Badge> : <Badge tone={TONE[w.status]}>{LABEL[w.status]}</Badge>}{w.via && w.via.startsWith("FILE") && <div className="text-xs text-sky-700">toko ditetapkan dari file</div>}</td>
              <td>{w.status === "BELUM_DI_ERP" && !sm.isBefore(w) && user.can("finance.create") && <Link className="btn-secondary btn-sm" href={`/finance?${new URLSearchParams({ baru: "1", wd: "1", nominal: String(w.fileAmount ?? 0), tanggal: wib(w.date), toko: m.storeId, kanal: m.channel, ref: w.refId.startsWith("Saldo Penjual") ? "" : w.refId })}`}>Catat withdraw ini</Link>}</td></tr>)}</tbody>
          </table></div>
          <p className="mt-2 text-xs text-slate-500">“Catat withdraw ini” membuka form Transaksi dengan nominal, tanggal, toko, dan ID referensi terisi; withdraw tidak pernah dibuat otomatis. Withdraw di rekening saldo bersama (satu rekening untuk semua toko) dikenali milik toko mana dari padanan file (ID referensi, atau nominal sama & tanggal 0–{m.channel === "TTS" ? 4 : 2} hari).</p>
        </Card></div>
        );
      })}
      <details className="card p-4 text-sm"><summary className="cursor-pointer font-semibold">Beda cara kerja saldo Shopee dan TikTok</summary><div className="mt-2">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li><b>TikTok</b>: saldo masuk (penyelesaian) <b>1× sehari sekitar pukul 08.00 WIB</b>. Isian “Saldo Seller Center” yang dibaca sebelum jam itu belum memuat penyelesaian hari tersebut, jadi ERP menambahkannya sesudahnya; yang dibaca sesudah 08.00 sudah memuatnya.</li>
          <li><b>TikTok withdraw</b> ke rekening bank tidak langsung masuk (1–3 hari). Saldo TikTok berkurang pada <b>waktu permintaan</b> withdraw (kolom “Waktu permintaan” di Riwayat penarikan), bukan saat uang masuk bank. Selama belum masuk, nilainya tampil sebagai <b>dana dalam perjalanan</b> dan dicocokkan dengan status withdraw di Keuangan (Dalam Proses → Uang diterima). Pencocokan file ↔ Keuangan memakai toleransi tanggal 0–4 hari.</li>
          <li><b>Shopee</b>: saldo masuk <b>per pesanan</b> saat pembeli konfirmasi diterima atau otomatis selesai (bisa berkali-kali sehari) dan sudah tercermin di file Saldo Penjual; penarikan umumnya langsung. Saldo resmi = Saldo Akhir baris terbaru file itu.</li>
        </ul>
      </div></details>
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
