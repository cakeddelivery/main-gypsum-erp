import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { sampleRecap, SAMPLE_SOURCES } from "@/lib/affiliateSample";
import { fmtDay } from "@/lib/time";
import { idr } from "@/lib/money";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Sample Affiliator" };

/** Rekap sample per affiliator (30 hari): jumlah, nilai beban promosi, rincian kiriman */
export default async function SampleAffiliator({ searchParams }: { searchParams: Promise<{ hari?: string }> }) {
  await requirePerm("audit.view");
  const q = await searchParams;
  const days = Math.min(365, Math.max(1, Number(q.hari) || 30));
  const r = await sampleRecap(days);
  return (
    <div className="space-y-5">
      <PageHeader title="Sample affiliator" subtitle={`${days} hari terakhir · ${r.list.length} affiliator · ${r.totalQty.toLocaleString("id-ID")} pcs · beban ${idr(r.totalValue)}`} actions={<><Link href={`/laporan/sample?hari=${days === 30 ? 90 : 30}`} className="btn-secondary">{days === 30 ? "90 hari" : "30 hari"}</Link><Link href="/laporan" className="btn-secondary">Kembali</Link></>} />
      <Card title="Rekap per affiliator">
        {!r.list.length ? <Empty title="Belum ada sample dikirim" hint="Catat di laporan Packing/Giftbox → langkah Sample." /> : (
          <div className="space-y-3">
            {r.list.map((a) => (
              <details key={a.affiliator} className="rounded-lg border border-slate-200 p-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <b>{a.affiliator}</b>
                  {[...a.sources].map((s) => <Badge key={s} tone="blue">{SAMPLE_SOURCES[s]?.split(" ")[0] ?? s}</Badge>)}
                  <span className="ml-auto tabular-nums text-slate-600">{a.qty.toLocaleString("id-ID")} pcs · <b>{idr(a.value)}</b></span>
                </summary>
                <div className="table-wrap mt-2"><Paged>
                  <table className="tbl">
                    <thead><tr><th>Tanggal</th><th>Produk</th><th className="num">Jumlah</th><th>Sumber</th><th>Resi</th><th className="num">Nilai</th></tr></thead>
                    <tbody>{a.lines.map((l, i) => <tr key={i}><td className="text-xs">{fmtDay(l.date)}</td><td className="!whitespace-normal">{l.item}</td><td className="num">{l.qty}</td><td className="text-xs">{SAMPLE_SOURCES[l.source]?.split(" ")[0] ?? l.source}</td><td className="font-mono text-xs">{l.trackingNo ?? "-"}</td><td className="num">{idr(l.value)}</td></tr>)}</tbody>
                  </table>
                </Paged></div>
              </details>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">Nilai = harga pokok × jumlah; dibukukan ke Beban Promosi & Sample Affiliator (bukan HPP penjualan) saat laporan dikirim dan sakelar Hasil kerja → stok menyala.</p>
      </Card>
    </div>
  );
}
