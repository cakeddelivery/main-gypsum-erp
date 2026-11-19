import type { ContractSnapshot } from "@/lib/contract";
import { idr } from "@/lib/money";

type Doc = {
  number: string;
  kind: "PKWT" | "ADD";
  status: string;
  snapshot: unknown;
  verifyCode: string;
  hrdSignedAt: Date | null;
  hrdSignedBy: string | null;
  employeeSignature: string | null;
  employeeSignedAt: Date | null;
  employeeDevice?: string | null;
};

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", month: "long", year: "numeric" });
const stamp = (d: Date | null) => (d ? `${d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(/\./g, ":").replace(",", "")} WIB` : "");

function Body({ text, snap }: { text: string; snap: ContractSnapshot }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ol key={`ol${out.length}`} className="mb-2 list-decimal pl-5">{list.map((l, i) => <li key={i} className="mb-1">{l}</li>)}</ol>);
    list = [];
  };
  lines.forEach((ln, i) => {
    const m = ln.match(/^\d+\.\s+(.*)$/);
    if (m) return void list.push(m[1]);
    flush();
    if (ln.trim() === "{{tabel_upah}}") out.push(<WageTable key={i} snap={snap} />);
    else if (ln.trim()) out.push(<p key={i} className="mb-2">{ln}</p>);
  });
  flush();
  return <>{out}</>;
}

function WageTable({ snap }: { snap: ContractSnapshot }) {
  const p = snap.pay;
  return (
    <table className="my-2 w-full border-collapse text-[12.5px]">
      <thead><tr>{["Komponen", "Nilai", "Waktu pembayaran"].map((h) => <th key={h} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
      <tbody>
        <tr><td className="border border-slate-300 px-2 py-1">Gaji pokok</td><td className="whitespace-nowrap border border-slate-300 px-2 py-1 text-right tabular-nums">{idr(p.baseSalary)}/bulan</td><td className="border border-slate-300 px-2 py-1">H+{p.payOffsetDays} setelah tanggal siklus masuk kerja (siklus tanggal {p.cycleDay} tiap bulan)</td></tr>
        {p.allowances.map((a, i) => (
          <tr key={i}><td className="border border-slate-300 px-2 py-1">Tunjangan {a.name}</td><td className="whitespace-nowrap border border-slate-300 px-2 py-1 text-right tabular-nums">{idr(a.amount)}/bulan</td><td className="border border-slate-300 px-2 py-1">Tanggal {a.payDay} tiap bulan</td></tr>
        ))}
        {p.bpjs.covered && <tr><td className="border border-slate-300 px-2 py-1">BPJS Ketenagakerjaan</td><td className="border border-slate-300 px-2 py-1 text-right">ditanggung penuh perusahaan</td><td className="border border-slate-300 px-2 py-1">mulai {monthName(p.bpjs.since)}</td></tr>}
      </tbody>
    </table>
  );
}

/** Surat perjanjian kerja / addendum (tema terang, siap cetak multi-halaman). `qr` = SVG QR verifikasi bila HRD sudah menandatangani. */
export function ContractDoc({ doc, qr, verifyUrl, id = "kontrak" }: { doc: Doc; qr: string | null; verifyUrl: string; id?: string }) {
  const s = doc.snapshot as ContractSnapshot;
  const title = doc.kind === "ADD" ? "Addendum Perjanjian Kerja Waktu Tertentu" : "Perjanjian Kerja Waktu Tertentu";
  const locked = doc.status === "AKTIF";
  return (
    <article id={id} className="contract-doc theme-light mx-auto w-full max-w-[794px] bg-white px-5 py-7 font-serif text-[13px] leading-relaxed text-slate-900 shadow-sm sm:px-10 print:max-w-none print:p-0 print:shadow-none">
      <style>{`@media print{@page{size:A4;margin:16mm 16mm 20mm;@bottom-left{content:"${doc.number}";font-size:9px;color:#64748b}@bottom-center{content:"Halaman " counter(page) " dari " counter(pages);font-size:9px;color:#64748b}@bottom-right{content:"Kode verifikasi: ${doc.verifyCode}";font-size:9px;color:#64748b}}.contract-doc h3,.contract-doc .nobreak{break-inside:avoid;break-after:avoid}.contract-doc .sign{break-inside:avoid}}`}</style>
      <header className="flex items-center gap-3 border-b-[3px] border-double border-blue-900 pb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-kop.png" alt="" width={56} height={56} className="h-14 w-14 object-contain" />
        <div>
          <div className="font-sans text-[22px] font-bold leading-none text-blue-900">{s.company.name}</div>
          <div className="font-sans text-[11px] uppercase tracking-[0.14em] text-slate-600">{s.company.tagline}</div>
          <div className="font-sans text-[11.5px] text-slate-600">{s.company.address} · {s.company.phone}</div>
        </div>
      </header>
      <h1 className="mb-1 mt-5 text-center text-[15px] font-bold uppercase tracking-wide">{title}</h1>
      <p className="mb-4 text-center text-[12.5px] text-slate-600">Nomor: <b>{doc.number}</b></p>
      <p className="mb-2">Pada hari ini <b>{longDate(s.signDate)}</b>, yang bertanda tangan di bawah ini:</p>
      <dl className="mb-2 ml-3 grid grid-cols-[120px_10px_1fr] gap-y-0.5">
        <dt>Nama</dt><dd>:</dd><dd className="font-bold">{s.hrd.name}</dd>
        <dt>Jabatan</dt><dd>:</dd><dd>{s.hrd.title} {s.company.name}</dd>
      </dl>
      <p className="mb-2">dalam hal ini bertindak untuk dan atas nama {s.company.name}, selanjutnya disebut <b>PIHAK PERTAMA</b>.</p>
      <dl className="mb-2 ml-3 grid grid-cols-[120px_10px_1fr] gap-y-0.5">
        <dt>Nama</dt><dd>:</dd><dd className="font-bold">{s.employee.name}</dd>
        <dt>NIK</dt><dd>:</dd><dd>{s.employee.nik}</dd>
        <dt>Alamat</dt><dd>:</dd><dd>{s.employee.address}</dd>
        <dt>Divisi / Jabatan</dt><dd>:</dd><dd>{s.employee.division} / {s.employee.position}</dd>
      </dl>
      <p className="mb-2">selanjutnya disebut <b>PIHAK KEDUA</b>. Kedua pihak sepakat mengikatkan diri dalam perjanjian kerja dengan ketentuan berikut.</p>
      {s.clauses.map((c, i) => (
        <section key={i}>
          <h3 className="mb-1 mt-4 text-center font-bold">{c.title}</h3>
          <Body text={c.body} snap={s} />
        </section>
      ))}
      <p className="mt-4 text-right">{s.city}, {longDate(s.signDate).replace(/^[A-Za-z]+, /, "")}</p>
      <div className="sign mt-5 grid grid-cols-2 gap-5 text-center">
        <div>
          <div className="text-[12.5px]">PIHAK PERTAMA</div>
          <div className="grid h-24 place-items-center">
            {qr ? <div dangerouslySetInnerHTML={{ __html: qr }} /> : <span className="rounded border border-dashed border-slate-300 px-2 py-1 font-sans text-[11px] text-slate-400">menunggu tanda tangan HRD</span>}
          </div>
          <div className="font-bold underline">{doc.hrdSignedBy ?? s.hrd.name}</div>
          <small className="block font-sans text-[10.5px] text-slate-600">{s.hrd.title}{doc.hrdSignedAt ? ` · tertanda digital ${stamp(doc.hrdSignedAt)} · pindai QR untuk verifikasi` : ""}</small>
        </div>
        <div>
          <div className="text-[12.5px]">PIHAK KEDUA</div>
          <div className="grid h-24 place-items-center">
            {doc.employeeSignature ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={doc.employeeSignature} alt={`Tanda tangan ${s.employee.name}`} className="max-h-20 max-w-[170px] object-contain" />
            ) : <span className="rounded border border-dashed border-slate-300 px-2 py-1 font-sans text-[11px] text-slate-400">menunggu tanda tangan karyawan</span>}
          </div>
          <div className="font-bold underline">{s.employee.name}</div>
          <small className="block font-sans text-[10.5px] text-slate-600">{doc.employeeSignedAt ? `ditandatangani di HP ${stamp(doc.employeeSignedAt)}` : ""}</small>
        </div>
      </div>
      <footer className="mt-5 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-1.5 font-sans text-[10px] text-slate-500 print:hidden">
        <span>{doc.number}</span>
        <span>{locked ? "Terkunci" : doc.status === "HRD_TTD" ? "Ditandatangani HRD" : doc.status === "BATAL" ? "Dibatalkan" : "Draf"}</span>
        <span>Kode verifikasi: {doc.verifyCode}</span>
      </footer>
      <span hidden data-verify-url={verifyUrl} />
    </article>
  );
}
