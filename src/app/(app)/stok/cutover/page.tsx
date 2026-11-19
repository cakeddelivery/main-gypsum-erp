import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { cutoverReadiness, countList } from "@/lib/cutover";
import { todayStr } from "@/lib/time";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadCsv } from "@/components/DownloadCsv";
import { Paged } from "@/components/Paged";
import { simpanTanggalMulai } from "./actions";

export const metadata = { title: "Cut-over Stok Terpadu" };

/** Kesiapan hari mulai stok terpadu: tanggal, daftar periksa, daftar hitung stok awal */
export default async function Cutover() {
  const user = await requirePerm("audit.view", "settings.manage");
  const [r, list] = await Promise.all([cutoverReadiness(), countList()]);
  const ready = r.checks.filter((c) => c.ok).length;
  const groups = [...new Set(list.map((x) => `${x.type} · ${x.division}`))];
  return (
    <div className="space-y-5">
      <PageHeader title="Cut-over stok terpadu" subtitle={r.date ? `Mulai ${r.date}${r.daysLeft != null ? ` · ${r.daysLeft >= 0 ? `${r.daysLeft} hari lagi` : `sudah berjalan ${-r.daysLeft} hari`}` : ""}` : "Tanggal mulai belum diatur"} actions={<Link href="/stok" className="btn-secondary">Kembali</Link>} />
      <Card title="Apa ini?">
        <p className="text-sm text-slate-700">Mulai tanggal ini, <b>stok di aplikasi dihitung dari laporan shift saja</b>: hasil produksi, pemakaian bahan, dan reject masuk otomatis, sedangkan menu Produksi manual hanya untuk koreksi Owner. Sebelum tanggal ini semuanya berjalan seperti biasa. Sehari sebelumnya semua barang dihitung fisik (stok awal) supaya mulai dari angka yang benar.</p>
        {user.can("settings.manage") && (
          <ActionForm action={simpanTanggalMulai} className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Tanggal mulai" className="w-44"><input type="date" name="date" defaultValue={r.date ?? todayStr()} className="input" required /></Field>
            <Submit className="btn-secondary">Simpan tanggal</Submit>
          </ActionForm>
        )}
      </Card>
      <Card title={`Daftar periksa kesiapan (${ready}/${r.checks.length})`}>
        <ul className="divide-y divide-slate-100 text-sm">
          {r.checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={c.ok ? "green" : "amber"}>{c.ok ? "siap" : "belum"}</Badge>
              <span className="min-w-0 flex-1"><b>{c.label}</b><span className="block text-xs text-slate-500">{c.detail}</span></span>
              {c.href && !c.ok && <Link href={c.href} className="btn-secondary btn-sm">Buka</Link>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">Urutan hari mulai: (1) hitung fisik semua barang sehari sebelumnya dan isi Stok awal riil; (2) pada tanggal mulai nyalakan sakelar Hasil kerja → stok; (3) laporan bertanggal sebelum tanggal mulai tidak ikut diposting.</p>
      </Card>
      <Card title={`Daftar hitung stok awal (${list.length} barang)`} actions={<DownloadCsv filename={`hitung-stok-awal-${todayStr()}`} label="Unduh daftar" rows={[["Jenis", "Divisi", "Kode", "Barang", "Satuan", "Stok sistem", "Hitung fisik"], ...list.map((x) => [x.type, x.division, x.sku, x.name, x.unit, x.system, ""])]} />}>
        <p className="mb-2 text-xs text-slate-500">Cetak/unduh daftar ini, hitung fisik tiap barang, lalu isi di <Link href="/stok/awal" className="underline">Stok awal riil</Link>. Dikelompokkan per jenis dan divisi pemilik.</p>
        {groups.map((g) => (
          <details key={g} className="mb-2 rounded-lg border border-slate-200 p-2">
            <summary className="cursor-pointer text-sm font-semibold">{g} <span className="font-normal text-slate-500">({list.filter((x) => `${x.type} · ${x.division}` === g).length})</span></summary>
            <div className="table-wrap mt-2"><Paged>
              <table className="tbl"><thead><tr><th>Kode</th><th>Barang</th><th className="num">Stok sistem</th></tr></thead>
                <tbody>{list.filter((x) => `${x.type} · ${x.division}` === g).map((x) => <tr key={x.sku}><td className="font-mono text-xs">{x.sku}</td><td className="!whitespace-normal">{x.name}</td><td className="num">{Number(x.system.toFixed(3)).toLocaleString("id-ID")} {x.unit}</td></tr>)}</tbody>
              </table>
            </Paged></div>
          </details>
        ))}
      </Card>
    </div>
  );
}
