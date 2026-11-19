import { verifyContract } from "@/lib/contract";
import { fmtDateTime, fmtDay } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verifikasi dokumen", robots: { index: false } };

/** Halaman publik hasil pindai QR: membuktikan dokumen asli (tanpa NIK, alamat, atau gaji) */
export default async function Verifikasi({ params }: { params: Promise<{ kode: string }> }) {
  const { kode } = await params;
  const v = /^MG-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(kode) ? await verifyContract(kode) : null;
  return (
    <main className="theme-light mx-auto min-h-screen max-w-lg bg-white p-5 text-slate-900">
      <h1 className="mb-1 text-xl font-extrabold">Verifikasi dokumen</h1>
      {!v ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-800">
          <b>Dokumen tidak ditemukan.</b>
          <p className="mt-1 text-sm">Kode verifikasi tidak dikenal atau dokumen belum ditandatangani. Pastikan kode di surat sama dengan yang dipindai.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className={`rounded-xl border p-4 ${v.intact && v.status !== "BATAL" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
            <b>{v.status === "BATAL" ? "Dokumen ini telah DIBATALKAN" : v.intact ? "Dokumen asli dan tidak berubah" : "Isi dokumen tidak cocok dengan hash"}</b>
            <p className="mt-1 text-sm">{v.status === "AKTIF" ? "Ditandatangani kedua pihak dan terkunci." : v.status === "HRD_TTD" ? "Ditandatangani HRD; menunggu tanda tangan karyawan." : ""}</p>
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">Perusahaan</dt><dd>{v.company}</dd>
            <dt className="text-slate-500">Nomor</dt><dd className="font-mono">{v.number}</dd>
            <dt className="text-slate-500">Jenis</dt><dd>{v.kind === "ADD" ? "Addendum" : "Perjanjian Kerja Waktu Tertentu"}</dd>
            <dt className="text-slate-500">Karyawan</dt><dd>{v.employee} · {v.division}</dd>
            <dt className="text-slate-500">Masa kerja</dt><dd>{fmtDay(v.start)} – {fmtDay(v.end)}</dd>
            <dt className="text-slate-500">Ditandatangani HRD</dt><dd>{v.hrd.name} ({v.hrd.title}) · {fmtDateTime(v.hrd.at)}</dd>
            <dt className="text-slate-500">Tanda tangan karyawan</dt><dd>{v.employeeSignedAt ? fmtDateTime(v.employeeSignedAt) : "belum"}</dd>
          </dl>
          <p className="break-all rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-500">SHA-256 isi: {v.contentHash}{v.finalHash && <><br />SHA-256 akhir: {v.finalHash}</>}</p>
        </div>
      )}
    </main>
  );
}
