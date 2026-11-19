import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ANOMALY_LABEL } from "@/lib/stockAlerts";
import { lpgSummary } from "@/lib/lpg";
import { REJECT_STAGE_LABEL, REJECT_REASONS } from "@/lib/rejectShared";
import { addDays, dateOnly, fmtDay, todayStr } from "@/lib/time";
import { idr } from "@/lib/money";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { jelaskanAnomali, periksaSekarang } from "./actions";

export const metadata = { title: "Kebocoran & Efisiensi" };
const TONE = { TINGGI: "red", SEDANG: "amber", RENDAH: "gray" } as const;

/** Asisten Owner: peringatan stok & produksi dalam bahasa awam, nilai uang yang bocor/tertahan, reject per tahap, LPG */
export default async function Kebocoran({ searchParams }: { searchParams: Promise<{ semua?: string }> }) {
  const user = await requirePerm("production.target", "audit.view");
  const q = await searchParams;
  const since = dateOnly(addDays(todayStr(), -14));
  const [list, rejects, lpg] = await Promise.all([
    prisma.stockAnomaly.findMany({ where: { date: { gte: since }, ...(q.semua ? {} : { status: { in: ["BARU", "DILIHAT"] } }) }, orderBy: [{ date: "desc" }, { severity: "desc" }, { value: "desc" }], take: 300 }),
    prisma.productionReject.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }),
    lpgSummary(7).catch(() => null),
  ]);
  const high = list.filter((x) => x.severity === "TINGGI").length;
  const leak = list.filter((x) => x.type === "NERACA_SELISIH" || x.type === "PAKAI_BERLEBIH").reduce((a, x) => a + Number(x.value), 0);
  const held = list.filter((x) => x.type === "BARANG_DIAM" || x.type === "RANTAI_PUTUS").reduce((a, x) => a + Number(x.value), 0);
  const byType = new Map<string, number>();
  for (const x of list) byType.set(x.type, (byType.get(x.type) ?? 0) + 1);
  const rejBy = new Map<string, { stage: string; reason: string; qty: number; value: number }>();
  for (const r of rejects) {
    const k = `${r.stage}|${r.reason}`;
    const c = rejBy.get(k) ?? { stage: r.stage, reason: r.reason, qty: 0, value: 0 };
    c.qty += Number(r.qty); c.value += Number(r.qty) * Number(r.unitCost);
    rejBy.set(k, c);
  }
  const rejRows = [...rejBy.values()].sort((a, b) => b.value - a.value);
  return (
    <div className="space-y-5">
      <PageHeader title="Kebocoran & Efisiensi" subtitle="Peringatan 14 hari terakhir · diperiksa otomatis tiap pagi" actions={<>{user.can("production.target") && <ActionForm action={periksaSekarang}><Submit className="btn-secondary" pendingText="Memeriksa…">Periksa sekarang</Submit></ActionForm>}<Link href={q.semua ? "/laporan/kebocoran" : "/laporan/kebocoran?semua=1"} className="btn-secondary">{q.semua ? "Hanya yang terbuka" : "Tampilkan semua"}</Link><Link href="/laporan/standar" className="btn-secondary">Standar</Link></>} />
      <div className="grid grid-cols-2 gap-2 keep-cols sm:grid-cols-4">
        {[["Peringatan terbuka", String(list.filter((x) => x.status !== "DIJELASKAN").length), false], ["Penting (merah)", String(high), high > 0], ["Perkiraan bocor", idr(leak), leak > 0], ["Uang tertahan di stok", idr(held), false]].map(([k, v, bad]) => (
          <div key={String(k)} className={`rounded-xl p-3 ${bad ? "bg-rose-50 text-rose-700" : "bg-slate-50"}`}><div className="text-xs font-semibold text-slate-500">{k}</div><div className="text-xl font-extrabold tabular-nums">{v}</div></div>
        ))}
      </div>
      <Card title="Ringkasan dalam bahasa sederhana">
        {!list.length ? <p className="text-sm text-slate-600">Tidak ada peringatan. Semua sesuai standar. 👍</p> : (
          <ul className="space-y-1 text-sm text-slate-700">
            {[...byType].map(([t, n]) => <li key={t}>• <b>{ANOMALY_LABEL[t]?.label ?? t}</b> ({n}): {ANOMALY_LABEL[t]?.hint}</li>)}
          </ul>
        )}
      </Card>
      <Card title={`Daftar peringatan (${list.length})`}>
        {!list.length ? <Empty title="Tidak ada peringatan" /> : (
          <div className="table-wrap"><Paged>
            <table className="tbl">
              <thead><tr><th>Tanggal</th><th>Peringatan</th><th className="num">Nilai</th><th>Status</th><th /></tr></thead>
              <tbody>{list.map((x) => (
                <tr key={x.id}>
                  <td className="text-xs">{fmtDay(x.date)}</td>
                  <td className="!whitespace-normal"><Badge tone={TONE[x.severity as keyof typeof TONE]}>{x.severity.toLowerCase()}</Badge> <b className="text-sm">{x.title}</b>{x.detail && <div className="text-xs text-slate-500">{x.detail}</div>}{x.reportId && <Link href={`/laporan/${x.reportId}`} className="text-xs text-brand-700 underline">buka laporan</Link>}{x.note && <div className="text-xs text-emerald-700">✓ {x.noteBy}: {x.note}</div>}</td>
                  <td className="num">{Number(x.value) ? idr(Number(x.value)) : "-"}</td>
                  <td className="text-xs">{x.status === "BARU" ? "baru" : x.status === "DILIHAT" ? "dilihat" : "dijelaskan"}</td>
                  <td>{user.can("production.target") && x.status !== "DIJELASKAN" && (
                    <Modal trigger="Jelaskan" triggerClass="btn-secondary btn-sm" title="Penjelasan peringatan" subtitle={x.title}>
                      <ModalForm action={jelaskanAnomali} className="space-y-3">
                        <input type="hidden" name="id" value={x.id} />
                        <Field label="Penjelasan (mis. sebab, tindakan)"><input name="note" className="input" required minLength={3} /></Field>
                        <div className="flex gap-2"><Submit name="status" value="DIJELASKAN">Sudah dijelaskan</Submit><Submit className="btn-secondary" name="status" value="DILIHAT">Hanya dilihat</Submit></div>
                      </ModalForm>
                    </Modal>
                  )}</td>
                </tr>))}</tbody>
            </table>
          </Paged></div>
        )}
      </Card>
      <Card title="Reject per tahap (30 hari)">
        {!rejRows.length ? <Empty title="Belum ada reject yang dilaporkan" /> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Tahap</th><th>Alasan</th><th className="num">Jumlah</th><th className="num">Nilai</th></tr></thead>
            <tbody>{rejRows.map((r) => <tr key={`${r.stage}${r.reason}`}><td>{REJECT_STAGE_LABEL[r.stage as keyof typeof REJECT_STAGE_LABEL] ?? r.stage}</td><td>{REJECT_REASONS[r.reason] ?? r.reason}</td><td className="num">{Number(r.qty.toFixed(2)).toLocaleString("id-ID")}</td><td className="num">{idr(r.value)}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      {lpg && (
        <Card title="LPG (7 hari)">
          <p className="text-sm text-slate-700">Tabung habis <b>{lpg.habis}</b> · isi ulang <b>{lpg.isiUlang}</b>{lpg.pricePerTabung ? <> · harga isi ulang ±<b>{idr(lpg.pricePerTabung)}</b> per tabung</> : null}{lpg.lateWaiting > 0 && <> · <span className="text-amber-700">{lpg.lateWaiting} isi ulang belum dicatat Finance</span></>}{lpg.totalMismatch && <> · <span className="text-rose-700">total tabung {lpg.latestTotal} ≠ aset {lpg.aset}</span></>}</p>
        </Card>
      )}
    </div>
  );
}
