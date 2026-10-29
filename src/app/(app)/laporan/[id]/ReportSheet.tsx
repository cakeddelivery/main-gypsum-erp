import { TEMPLATES, isDone, needsOrder, summaryOf, workLines, type ChecklistEntry, type ReportTemplate, type StockCountRow, type WorkData } from "@/lib/shiftReport";

type Props = {
  id: string;
  date: string;
  division: string;
  shift: string;
  pic: string;
  template: ReportTemplate | null;
  work: WorkData;
  checklist: ChecklistEntry[];
  stock: StockCountRow[];
  complaints: string | null;
  followUp: string | null;
  followUpStatus: string;
  /** Laporan lama/umum: ringkasan hasil produksi dari modul Produksi */
  legacyLines?: string[];
};

const fmt = (v: number) => v.toLocaleString("id-ID");

/** Tampilan "Laporan Penutup Shift" (warna tetap terang agar sama saat diunduh JPG) */
export function ReportSheet(p: Props) {
  const done = p.checklist.filter(isDone).length;
  const photos = p.checklist.filter((c) => c.photoPath).length;
  const order = p.stock.filter(needsOrder);
  const summary = p.template ? summaryOf(p.template, p.work) : [];
  const lines = p.template ? workLines(p.template, p.work) : (p.legacyLines ?? []);
  const label = p.template ? TEMPLATES[p.template].label : p.division;
  return (
    <div id="report-preview" className="theme-light overflow-hidden rounded-xl border border-[#e5e7eb] bg-[#fffbe8] text-[#1f2937]">
      <div className="flex items-center gap-3 bg-[#fff200] px-4 py-4 sm:gap-5 sm:px-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-maingypsum.png" alt="Main Gypsum" className="h-10 w-auto shrink-0 sm:h-14" />
        <div className="min-w-0">
          <div className="text-lg font-extrabold leading-tight tracking-wide text-[#1e3a8a] sm:text-2xl">LAPORAN PENUTUP SHIFT</div>
          <div className="text-xs text-[#1f2937] sm:text-sm">Standar Kinerja Operasional</div>
          <div className="mt-0.5 text-sm font-bold text-[#1f2937] sm:text-base">{label} • {p.shift}</div>
        </div>
      </div>
      <div className="h-2 bg-[#2563eb]" />
      <div className="space-y-3 px-4 py-4 sm:px-6">
        <div>
          <div className="text-base font-bold sm:text-lg">{p.date} | PIC Divisi: {p.pic}</div>
          {summary.length > 0 && <div className="text-sm text-[#4b5563]">{summary.map((s) => `${s.label}: ${fmt(s.value)}${s.unit ? ` ${s.unit}` : ""}`).join(" | ")}</div>}
        </div>

        <Heading tone="blue">Detail hasil kerja</Heading>
        <div className="space-y-0.5 px-2 text-[13px] leading-relaxed text-[#374151]">
          {lines.length ? lines.map((l, i) => <div key={i} className="break-words">{l}</div>) : <div className="text-[#9ca3af]">Belum diisi</div>}
        </div>

        <Heading tone="blue">Checklist penutupan {done}/{p.checklist.length}</Heading>
        <ul className="space-y-1.5">
          {p.checklist.map((c, i) => {
            const ok = isDone(c);
            return (
              <li key={i} className={`flex items-center gap-3 rounded-md px-3 py-1.5 text-sm ${ok ? "bg-[#ecfdf5]" : "bg-[#fdecef]"}`}>
                <span className={`w-4 shrink-0 font-bold ${ok ? "text-[#059669]" : "text-[#dc2626]"}`}>{ok ? "✓" : "×"}</span>
                <span className="min-w-0 flex-1">{c.label}</span>
                {c.photoPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/files/report/${p.id}/${i}?v=${encodeURIComponent(c.photoPath.split("/").pop() ?? "")}`} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                ) : c.photo ? (
                  <span className="shrink-0 text-xs text-[#6b7280]">foto belum ada</span>
                ) : null}
              </li>
            );
          })}
        </ul>

        {p.stock.length > 0 && (
          <>
            <Heading tone="amber">Stok akhir shift</Heading>
            <table className="w-full text-[13px]">
              <tbody>
                {p.stock.map((s) => {
                  const low = needsOrder(s);
                  return (
                    <tr key={s.itemId}>
                      <td className={`py-0.5 pl-2 ${low ? "text-[#c2410c]" : ""}`}>{low ? "⚠" : "•"} {s.name}</td>
                      <td className="whitespace-nowrap py-0.5 text-right font-semibold">{s.qty == null ? "—" : `${fmt(s.qty)} ${s.unit}`}</td>
                      <td className="whitespace-nowrap py-0.5 pl-3 text-xs text-[#6b7280]">limit {fmt(s.limit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <Heading tone="red">Order bahan baku</Heading>
            {order.length ? (
              <ul className="space-y-0.5 px-2 text-sm">
                {order.map((o) => (
                  <li key={o.itemId} className="flex flex-wrap justify-between gap-x-3">
                    <span className="text-[#be123c]">⚠ {o.name}</span>
                    <span className="text-[#4b5563]">stok {fmt(o.qty!)} {o.unit} · limit {fmt(o.limit)} {o.unit}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-2 text-sm text-[#6b7280]">Semua bahan di atas limit</div>
            )}
          </>
        )}

        {(p.complaints || p.followUp) && (
          <div className="rounded-lg bg-[#ffffff] p-3 text-sm">
            {p.complaints && (<><div className="font-bold">CATATAN / KENDALA</div><div className="text-[#4b5563]">{p.complaints}</div></>)}
            {p.followUp && <div className="mt-1 text-[#4b5563]"><b>Tindak lanjut ({p.followUpStatus}):</b> {p.followUp}</div>}
          </div>
        )}
        <div className="pt-4 text-xs text-[#6b7280]">Dibuat dari Laporan Shift • {photos} foto bukti</div>
      </div>
    </div>
  );
}

function Heading({ tone, children }: { tone: "blue" | "amber" | "red"; children: React.ReactNode }) {
  const c = { blue: "bg-[#eaf4fd] text-[#1e4f8a]", amber: "bg-[#fdf1cf] text-[#8a5a00]", red: "bg-[#fde2e7] text-[#be123c]" }[tone];
  return <div className={`rounded-lg px-3 py-2 text-sm font-bold uppercase ${c}`}>{children}</div>;
}
