import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { businessSnapshot, growth, ruleInsights } from "@/lib/analytics";
import { advisorConfigured, lastAdvice } from "@/lib/advisor";
import { idr } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { BarsChart, TrendChart } from "@/components/Charts";
import { requestAdvice } from "./actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Analitik & Advisor" };

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${Math.abs(v).toLocaleString("id-ID")}%`);
const TONE = { red: "border-rose-200 bg-rose-50", amber: "border-amber-200 bg-amber-50", green: "border-emerald-200 bg-emerald-50", blue: "border-slate-200 bg-white" } as const;

export default async function AnalitikPage() {
  await requirePerm("accounting.view");
  const [s, advice] = await Promise.all([businessSnapshot(), lastAdvice()]);
  const insights = ruleInsights(s);
  const g = growth(s.prev.revenue, s.series[s.series.length - 3]?.revenue ?? 0);
  const ai = advisorConfigured();
  return (
    <div className="space-y-5">
      <PageHeader title="Analitik bisnis & advisor" subtitle="Pertumbuhan, arus kas, kewajiban 30 hari, dan saran strategis" actions={<Link href="/akuntansi/laba-rugi" className="btn-secondary">Laba rugi</Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Pendapatan ${s.cur.label} (berjalan)`} value={idr(s.cur.revenue)} hint={`Bulan lalu ${idr(s.prev.revenue)}${g !== null ? ` (${pct(g)} vs bulan sebelumnya)` : ""}`} />
        <Stat label={`Laba bersih ${s.cur.label}`} value={idr(s.cur.net)} tone={s.cur.net >= 0 ? "green" : "red"} hint={`Bulan lalu ${idr(s.prev.net)}`} />
        <Stat label="Kas bebas" value={idr(s.freeCash)} tone={s.freeCash >= 0 ? "slate" : "red"} hint={`Total kas ${idr(s.cash)} − titipan owner ${idr(s.ownerHeld)} − tabungan cicilan ${idr(s.loanSaving)}`} />
        <Stat label="Proyeksi kas 30 hari" value={idr(s.projected30)} tone={s.projected30 >= 0 ? "green" : "red"} hint={s.runwayMonths !== null ? `Runway ±${s.runwayMonths} bulan` : "Pemasukan rata-rata ≥ pengeluaran"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Pendapatan, beban & laba per bulan">
          <TrendChart data={s.series.map((m) => ({ label: m.label, pendapatan: m.revenue, beban: m.cogs + m.expenses, laba: m.net }))} series={[{ key: "pendapatan", label: "Pendapatan", color: "#2563eb" }, { key: "beban", label: "HPP + beban", color: "#f97316" }, { key: "laba", label: "Laba bersih", color: "#16a34a" }]} />
        </Card>
        <Card title="Arus kas per bulan">
          <BarsChart data={s.series.map((m) => ({ label: m.label, masuk: m.cashIn, keluar: m.cashOut }))} series={[{ key: "masuk", label: "Kas masuk", color: "#16a34a" }, { key: "keluar", label: "Kas keluar", color: "#e11d48" }]} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Saran strategis otomatis" className="lg:col-span-2">
          <ul className="space-y-2">
            {insights.map((i, k) => (
              <li key={k} className={`rounded-lg border p-3 ${TONE[i.tone]}`}><div className="text-sm font-medium">{i.title}</div><div className="text-sm text-slate-600">{i.detail}</div></li>
            ))}
          </ul>
        </Card>
        <Card title="Kewajiban 30 hari ke depan">
          <ul className="divide-y divide-slate-100 text-sm">
            {s.obligations.map((o) => <li key={o.label} className="flex justify-between gap-2 py-1.5"><span>{o.label}</span><span className="tabular-nums">{idr(o.amount)}</span></li>)}
            <li className="flex justify-between py-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{idr(s.obligations30)}</span></li>
          </ul>
          <div className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between"><span>Utang supplier</span><span className="tabular-nums">{idr(s.supplierDebt)}</span></div>
            <div className="flex justify-between"><span>Pinjaman modal</span><span className="tabular-nums">{idr(s.loanDebt)}</span></div>
            <div className="flex justify-between"><span>Piutang</span><span className="tabular-nums">{idr(s.receivables)}</span></div>
            <div className="flex justify-between"><span>Kasbon karyawan</span><span className="tabular-nums">{idr(s.advances)}</span></div>
            <div className="flex justify-between"><span>Nilai persediaan</span><span className="tabular-nums">{idr(s.inventory)}</span></div>
          </div>
        </Card>
      </div>

      <Card title="AI advisor" actions={<Badge tone={ai ? "green" : "gray"}>{ai ? "Aktif" : "Belum aktif"}</Badge>}>
        {ai ? (
          <ActionForm action={requestAdvice} className="mb-4 flex flex-wrap items-end gap-2">
            <label className="min-w-64 flex-1"><span className="label">Pertanyaan (opsional)</span><input name="question" className="input" placeholder="mis. Apakah aman menambah 2 karyawan bulan depan?" /></label>
            <Submit pendingText="AI sedang menganalisis…">Minta saran AI</Submit>
          </ActionForm>
        ) : (
          <p className="mb-3 text-sm text-slate-500">Saran otomatis di atas sudah berjalan tanpa biaya. Untuk analisis lebih dalam dengan AI, pasang <code>ANTHROPIC_API_KEY</code> (atau <code>AI_BASE_URL</code> + <code>AI_API_KEY</code> untuk provider OpenAI-compatible) di file .env server lalu restart aplikasi. Ringkasan angka bulanan (tanpa data pribadi karyawan) dikirim ke provider AI setiap kali tombol ditekan.</p>
        )}
        {advice && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="mb-2 text-xs text-slate-500">{fmtDateTime(advice.at)}{advice.question && ` · "${advice.question}"`}</div>
            <div className="whitespace-pre-wrap leading-relaxed">{advice.text}</div>
          </div>
        )}
      </Card>

      <Card title="Tabel bulanan">
        <div className="overflow-x-auto">
          <Paged><table className="tbl">
            <thead><tr><th>Bulan</th><th className="num">Pendapatan</th><th className="num">Growth</th><th className="num">HPP</th><th className="num">Beban</th><th className="num">Kompensasi owner</th><th className="num">Laba bersih</th><th className="num">Kas akhir</th></tr></thead>
            <tbody>
              {s.series.map((m, i) => (
                <tr key={m.key}>
                  <td>{m.label}{i === s.series.length - 1 && <span className="text-xs text-slate-400"> (berjalan)</span>}</td><td className="num">{idr(m.revenue)}</td><td className="num">{i ? pct(growth(m.revenue, s.series[i - 1].revenue)) : "—"}</td><td className="num">{idr(m.cogs)}</td><td className="num">{idr(m.expenses)}</td><td className="num">{idr(m.ownerComp)}</td>
                  <td className={`num font-medium ${m.net < 0 ? "text-rose-600" : ""}`}>{idr(m.net)}</td><td className="num">{idr(m.cashEnd)}</td>
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      </Card>
    </div>
  );
}
