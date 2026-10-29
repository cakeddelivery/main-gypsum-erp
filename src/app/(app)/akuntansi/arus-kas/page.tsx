import { requirePerm } from "@/lib/auth";
import { cashFlow } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { letterhead } from "@/lib/letterhead";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocBar, DocSection, DocSheet, DocSummary, DocTable, fmtLong, fmtRange } from "@/components/DocSheet";
import { parseRange, ReportFilter, storeLabel, type SP } from "../shared";

export const metadata = { title: "Arus Kas" };
const SECTIONS = [
  { key: "OPERASI", no: 1, tone: "blue", title: "Aktivitas operasi", hint: "Penerimaan dan pengeluaran dari aktivitas utama bisnis" },
  { key: "INVESTASI", no: 2, tone: "green", title: "Aktivitas investasi", hint: "Penerimaan dan pengeluaran dari aktivitas investasi" },
  { key: "PENDANAAN", no: 3, tone: "amber", title: "Aktivitas pendanaan", hint: "Penerimaan dan pengeluaran dari aktivitas pendanaan" },
] as const;
const num = (v: number) => (v ? Math.abs(v).toLocaleString("id-ID") : "-");
const signed = (v: number) => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("id-ID");

export default async function ArusKas({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("accounting.view");
  const sp = await searchParams;
  const r = parseRange(sp);
  const [cf, lh, store] = await Promise.all([cashFlow({ start: r.start, end: r.end, storeId: r.storeId }), letterhead(), storeLabel(r.storeId)]);
  const net = cf.operating + cf.investing + cf.financing;
  const totals = { OPERASI: cf.operating, INVESTASI: cf.investing, PENDANAAN: cf.financing };
  return (
    <div>
      <PageHeader title="Laporan arus kas" subtitle="Metode langsung; transfer antar rekening tidak dihitung" actions={<DownloadJpg targetId="ak" filename={`arus-kas-${r.from}-${r.to}`} />} />
      <ReportFilter sp={sp} />
      <DocSheet
        id="ak"
        lh={lh}
        eyebrow="Laporan keuangan"
        title="Laporan Arus Kas"
        subtitle={store}
        meta={{ label: "Periode Laporan", value: fmtRange(r.from, r.to) }}
        signerOrg={store.replace(/^Konsolidasi /, "")}
        signDate={r.to}
        notes={[`Laporan ini merupakan laporan arus kas ${store.charAt(0).toLowerCase() + store.slice(1)}.`, `Periode laporan: ${fmtRange(r.from, r.to)}.`, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
      >
        <DocBar label="Saldo kas awal" note={`Saldo kas per ${fmtLong(r.from)}`} value={idr(cf.opening)} negative={cf.opening < 0} />
        {SECTIONS.map((s) => {
          let bal = 0;
          const rows = cf.groups[s.key];
          return (
            <DocSection key={s.key} no={s.no} tone={s.tone} title={s.title} hint={s.hint}>
              <DocTable
                head={<tr><th>Tanggal</th><th>No. Jurnal</th><th>Deskripsi</th><th className="num">Masuk (Rp)</th><th className="num">Keluar (Rp)</th><th className="num">Saldo (Rp)</th></tr>}
                empty={rows.length ? undefined : "Tidak ada transaksi pada periode ini"}
              >
                {rows.map((x, i) => {
                  bal += x.amount;
                  return (
                    <tr key={i}>
                      <td className="whitespace-nowrap">{fmtDate(x.date)}</td>
                      <td className="whitespace-nowrap">{x.number}</td>
                      <td>{x.memo}</td>
                      <td className="num">{x.amount > 0 ? num(x.amount) : "-"}</td>
                      <td className={`num ${x.amount < 0 ? "doc-neg" : ""}`}>{x.amount < 0 ? num(x.amount) : "-"}</td>
                      <td className={`num ${bal < 0 ? "doc-neg" : ""}`}>{signed(bal)}</td>
                    </tr>
                  );
                })}
              </DocTable>
              <DocBar label={`Kas bersih ${s.title.toLowerCase()}`} value={idr(totals[s.key])} tone={s.tone === "amber" ? "amber" : "blue"} negative={totals[s.key] < 0} />
            </DocSection>
          );
        })}
        <DocSummary
          rows={[
            { label: "Kenaikan (penurunan) kas", hint: "Total perubahan kas selama periode laporan", value: idr(net), negative: net < 0 },
            { label: "Saldo kas akhir", hint: `Saldo kas per ${fmtLong(r.to)}`, value: idr(cf.closing), negative: cf.closing < 0, strong: true },
          ]}
        />
      </DocSheet>
    </div>
  );
}
