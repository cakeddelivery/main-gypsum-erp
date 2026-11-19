import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { kindLabel, stockGapReport } from "@/lib/stockGap";
import { fmtDay } from "@/lib/time";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Selisih Stok vs Laporan" };
const f = (n: number) => Number(n.toFixed(3)).toLocaleString("id-ID");

/** Hanya membaca: stok aplikasi vs stok akhir laporan shift (setengah jadi / jadi) + mutasi borongan, 14 hari terakhir */
export default async function SelisihStok({ searchParams }: { searchParams: Promise<{ hari?: string }> }) {
  await requirePerm("audit.view");
  const q = await searchParams;
  const days = Math.min(60, Math.max(1, Number(q.hari) || 14));
  const r = await stockGapReport(days);
  const diff = r.rows.filter((x) => x.diff !== 0);
  const divisions = [...new Set(r.flows.map((x) => x.division ?? "(tanpa divisi)"))];
  return (
    <div className="space-y-5">
      <PageHeader title="Selisih stok vs laporan shift" subtitle={`${r.from} s/d hari ini · ${r.reportsChecked} laporan terkirim · hanya membaca`} actions={<Link href="/stok" className="btn-secondary">Kembali</Link>} />
      <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${r.settingOn ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
        Setting <code>laporan_shift_ke_stok</code> = <b>{r.setting ?? "(belum diatur)"}</b> — {r.settingOn ? "hasil kerja laporan shift diposting ke stok." : "MATI: hasil kerja laporan shift tidak diposting ke stok, jadi selisih di bawah wajar muncul."}
      </div>
      <Card title={`Stok akhir laporan vs stok aplikasi (${diff.length} selisih dari ${r.rows.length} barang)`}>
        {!r.rows.length ? <Empty title="Belum ada hitungan stok akhir di laporan periode ini" /> : (
          <div className="table-wrap"><Paged>
            <table className="tbl">
              <thead><tr><th>Laporan</th><th>Barang</th><th className="num">Laporan</th><th className="num">Aplikasi</th><th className="num">Selisih</th></tr></thead>
              <tbody>{r.rows.map((x) => (
                <tr key={`${x.reportId}${x.itemId}`}>
                  <td className="!whitespace-normal text-xs"><Link href={`/laporan/${x.reportId}`} className="underline">{x.division} · {x.shift}</Link><div className="text-slate-500">{fmtDay(new Date(x.date))}</div></td>
                  <td className="!whitespace-normal">{x.name}</td>
                  <td className="num">{f(x.counted)}</td><td className="num">{f(x.system)}</td>
                  <td className={`num font-semibold ${x.diff === 0 ? "text-slate-400" : x.diff < 0 ? "text-rose-700" : "text-emerald-700"}`}>{x.diff > 0 ? "+" : ""}{f(x.diff)} {x.big && <Badge tone="red">besar</Badge>}</td>
                </tr>))}</tbody>
            </table>
          </Paged></div>
        )}
      </Card>
      <Card title="Mutasi setengah jadi & jadi per jenis (termasuk borongan KRM/BGI/HSB/PND)">
        {!r.flows.length ? <Empty title="Tidak ada mutasi" /> : divisions.map((d) => (
          <section key={d} className="mb-4">
            <h3 className="mb-1 text-sm font-bold text-slate-600">{d}</h3>
            <div className="table-wrap"><Paged>
              <table className="tbl">
                <thead><tr><th>Barang</th><th>Jenis</th><th className="num">Kali</th><th className="num">Masuk</th><th className="num">Keluar</th></tr></thead>
                <tbody>{r.flows.filter((x) => (x.division ?? "(tanpa divisi)") === d).map((x) => (
                  <tr key={`${x.itemId}${x.kind}`}><td className="!whitespace-normal">{x.item}</td><td className="!whitespace-normal text-xs">{kindLabel(x.kind)}</td><td className="num">{x.count}</td><td className="num">{f(x.masukWip)}</td><td className="num">{f(x.keluarWip)}</td></tr>))}</tbody>
              </table>
            </Paged></div>
          </section>
        ))}
        <p className="text-xs text-slate-500">Masuk/keluar = ke/dari gudang setengah jadi & barang jadi. KRM/BGI memindahkan ke driver/titik (keluar dari gudang), PND mengembalikan setoran ke gudang.</p>
      </Card>
    </div>
  );
}
