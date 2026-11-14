import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { AREA_LABEL, STALE, runConsistency, type Area, type Issue } from "@/lib/consistency";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";

export const metadata = { title: "Cek Konsistensi" };
export const dynamic = "force-dynamic";

const TONE = { KRITIS: "red", SEDANG: "amber", INFO: "gray" } as const;
const LABEL = { KRITIS: "Kritis", SEDANG: "Sedang", INFO: "Info" } as const;
const MAX_ITEMS = 50;

/**
 * Cek Konsistensi (hanya membaca): uang, barang, absensi → gaji, dan karyawan. Setiap masalah berisi daftar dokumen
 * bermasalah + tautannya. Khusus pemegang izin tutup buku (Owner & Finance). Juga dijalankan otomatis 06.00.
 */
export default async function KonsistensiPage() {
  await requirePerm("accounting.close");
  const r = await runConsistency();
  const count = (l: Issue["level"]) => r.issues.filter((i) => i.level === l).length;
  const areas = (Object.keys(AREA_LABEL) as Area[]).map((a) => ({ a, list: r.issues.filter((i) => i.area === a) }));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Cek konsistensi"
        subtitle={`${r.checks} pemeriksaan · ${fmtDateTime(r.at)} · hanya membaca, tidak mengubah data`}
        actions={<Link href="/akuntansi/konsistensi" className="btn-secondary">↻ Jalankan ulang</Link>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kritis" value={count("KRITIS")} tone={count("KRITIS") ? "red" : "green"} hint="uang/stok/gaji bisa salah" />
        <Stat label="Sedang" value={count("SEDANG")} tone={count("SEDANG") ? "amber" : "green"} hint="perlu ditindaklanjuti" />
        <Stat label="Info" value={count("INFO")} hint="pengingat" />
        <Stat label="Pemeriksaan lolos" value={`${r.checks - r.issues.length}/${r.checks}`} tone="green" />
      </div>
      <p className="text-sm text-slate-500">
        Diperiksa: jurnal seimbang & tidak ganda, transaksi tanpa status akhir (draft &gt; {STALE.draft} hari, WD dalam proses &gt; {STALE.wdProcess} hari), dokumen batal yang belum dibalik,
        saldo rekening, hutang/piutang/kasbon/uang muka vs akun, sisihan, penyusutan, nilai stok vs akun persediaan, stok minus, barang masuk belum dibeli, serah terima & permintaan menggantung,
        upah borongan, absen belum divalidasi / hari tanpa absen, siklus gaji tanpa slip, gaji dobel, Hutang Gaji, akses karyawan resign, pendaftaran menunggu.
        Ringkasan Kritis/Sedang dikirim ke Owner lewat bot setiap pukul 06.00.
      </p>
      {r.issues.length === 0 ? <Empty title="Semua konsisten ✓" /> : areas.filter((x) => x.list.length).map(({ a, list }) => (
        <Card key={a} title={`${AREA_LABEL[a]} (${list.length})`}>
          <div className="space-y-4">
            {list.map((i) => (
              <section key={i.key}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[i.level]}>{LABEL[i.level]}</Badge>
                  <h3 className="font-medium">{i.title}</h3>
                  <span className="text-xs text-slate-500">{i.items.length} temuan</span>
                </div>
                <p className="mt-1 text-sm text-slate-500">{i.hint}</p>
                <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-700">
                  {i.items.slice(0, MAX_ITEMS).map((x, k) => (
                    <li key={k} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5">
                      <span className="font-medium">{x.href ? <Link href={x.href} className="link">{x.label}</Link> : x.label}</span>
                      {x.detail && <span className="text-slate-600 dark:text-slate-400">{x.detail}</span>}
                    </li>
                  ))}
                  {i.items.length > MAX_ITEMS && <li className="px-3 py-1.5 text-xs text-slate-500">… dan {i.items.length - MAX_ITEMS} lainnya</li>}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
