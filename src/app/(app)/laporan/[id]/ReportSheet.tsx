import type { Letterhead } from "@/lib/letterhead";
import { DocExport, DocSheet, fmtLong } from "@/components/DocSheet";
import type { ResultRow } from "@/lib/shiftResultCount";
import { TEMPLATES, isDone, needsOrder, summaryOf, targetLine, targetOf, workBlocks, type ChecklistEntry, type ReportTemplate, type StockCountRow, type WorkBlock, type WorkData } from "@/lib/shiftReport";

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
  /** Hasil borongan di tanggal ini (dari setoran, hanya ditampilkan) */
  extraLines?: string[];
  /** Barang masuk dari supplier/toko di shift ini */
  receiptLines?: string[];
  /** Hitungan stok akhir setengah jadi / jadi vs sistem (tabel Barang | Fisik | Sistem | Selisih) */
  resultRows?: ResultRow[];
  /** Target hasil per shift divisi */
  target?: number | null;
  lh: Letterhead;
};

const fmt = (v: number) => v.toLocaleString("id-ID");

/** Tampilan "Laporan Penutup Shift" di layar, plus versi ber-kop surat (tersembunyi) untuk unduhan JPG */
export function ReportSheet(p: Props) {
  const done = p.checklist.filter(isDone).length;
  const photos = p.checklist.filter((c) => c.photoPath).length;
  const order = p.stock.filter(needsOrder);
  const summary = p.template ? summaryOf(p.template, p.work) : [];
  const toLine = (text: string): WorkBlock => ({ kind: "line", text });
  const blocks: WorkBlock[] = p.template ? [...workBlocks(p.template, p.work), ...(p.extraLines ?? []).map(toLine)] : (p.legacyLines ?? []).map(toLine);
  const tgt = p.template ? targetOf(p.template, p.work, p.target) : null;
  const label = p.template ? TEMPLATES[p.template].label : p.division;
  const sum = summary.length > 0 && (
    <>
      <div className="text-sm text-[#4b5563]">{summary.map((s) => `${s.label}: ${fmt(s.value)}${s.unit ? ` ${s.unit}` : ""}`).join(" | ")}</div>
      {tgt && <div className={`text-sm font-semibold ${tgt.reached ? "text-[#059669]" : "text-[#dc2626]"}`}>{targetLine(tgt)}</div>}
    </>
  );
  // Stok akhir setengah jadi / jadi: hanya yang ada stoknya atau berselisih; sisanya (0 & sesuai sistem) dirangkum satu baris
  const rr = p.resultRows ?? [];
  const rrShown = rr.filter((r) => r.notCounted ? r.system !== 0 : r.counted > 0 || r.diff !== 0 || r.system > 0);
  const rrHidden = rr.filter((r) => !r.notCounted).length - rrShown.filter((r) => !r.notCounted).length;
  const rrUncounted0 = rr.filter((r) => r.notCounted && r.system === 0).length;
  // wide = versi JPG (lebar 1080px, font dasar ≥ 28px agar terbaca di HP tanpa zoom); di layar versi ringkas
  const body = (wide: boolean) => {
    const z = wide
      ? { txt: "text-[28px] leading-snug", small: "text-[24px]", head: "text-[26px]", gap: "space-y-3", pad: "px-4 py-2.5", th: "text-[22px]" }
      : { txt: "text-[13px] leading-relaxed", small: "text-xs", head: "text-sm", gap: "space-y-1", pad: "px-3 py-1.5", th: "text-xs" };
    return (
    <>
        <Heading tone="blue" wide={wide}>Detail hasil kerja</Heading>
        <div className={`${z.gap} px-2 ${z.txt} text-[#374151]`}>
          {blocks.length ? blocks.map((b, i) => (b.kind === "line" ? <div key={i} className="break-words">{b.text}</div> : <WorkGroups key={i} b={b} wide={wide} />)) : <div className="text-[#9ca3af]">Belum diisi</div>}
        </div>

        {rr.length > 0 && (
          <>
            <Heading tone="blue" wide={wide}>Stok akhir setengah jadi / produk jadi</Heading>
            <table className={`w-full ${z.txt}`}>
              <thead>
                <tr className={`${z.th} text-[#6b7280]`}>
                  <th className="px-2 py-1 text-left font-semibold">Barang</th>
                  <th className="px-2 py-1 text-right font-semibold">Fisik</th>
                  <th className="px-2 py-1 text-right font-semibold">Sistem</th>
                  <th className="px-2 py-1 text-right font-semibold">Selisih</th>
                </tr>
              </thead>
              <tbody>
                {rrShown.map((r) => (
                  <tr key={r.itemId} className="border-t border-[#e5e7eb]">
                    <td className="px-2 py-1 break-words">{r.name}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums">{r.notCounted ? "—" : fmt(r.counted)}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[#6b7280]">{fmt(r.system)}</td>
                    <td className={`whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums ${r.notCounted ? "text-[#c2410c]" : r.diff === 0 ? "text-[#059669]" : r.big ? "text-[#b91c1c]" : "text-[#c2410c]"}`}>{r.notCounted ? "belum dihitung" : r.diff === 0 ? "✓" : `${r.diff > 0 ? "+" : ""}${fmt(r.diff)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rrShown.length === 0 && <div className={`px-2 ${z.small} text-[#6b7280]`}>Tidak ada stok.</div>}
            {rrHidden > 0 && <div className={`px-2 ${z.small} text-[#6b7280]`}>{rrHidden} item lain: 0, sesuai sistem</div>}
            {rrUncounted0 > 0 && <div className={`px-2 ${z.small} text-[#6b7280]`}>{rrUncounted0} item belum dihitung (stok sistem 0)</div>}
          </>
        )}

        <Heading tone="blue" wide={wide}>Checklist penutupan {done}/{p.checklist.length}</Heading>
        <ul className={`grid gap-1.5 ${wide ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"}`}>
          {p.checklist.map((c, i) => {
            const ok = isDone(c);
            return (
              <li key={i} className={`flex items-center gap-2 rounded-md ${z.pad} ${wide ? "text-[24px] leading-tight" : "text-sm"} ${ok ? "bg-[#ecfdf5]" : "bg-[#fdecef]"}`}>
                <span className={`shrink-0 font-bold ${ok ? "text-[#059669]" : "text-[#dc2626]"}`}>{ok ? "✓" : "×"}</span>
                <span className="min-w-0 flex-1 break-words">{c.label}</span>
                {c.photoPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/files/report/${p.id}/${i}?v=${encodeURIComponent(c.photoPath.split("/").pop() ?? "")}`} alt="" className={`shrink-0 rounded object-cover ${wide ? "h-12 w-12" : "h-8 w-8"}`} />
                ) : c.photo ? (
                  <span className={`shrink-0 ${wide ? "text-[18px]" : "text-xs"} text-[#6b7280]`}>foto belum ada</span>
                ) : null}
              </li>
            );
          })}
        </ul>

        {(p.receiptLines?.length ?? 0) > 0 && (
          <>
            <Heading tone="amber" wide={wide}>Barang masuk</Heading>
            <ul className={`space-y-0.5 px-2 ${z.txt} text-[#374151]`}>{p.receiptLines!.map((l, i) => <li key={i}>• {l}</li>)}</ul>
          </>
        )}

        {p.stock.length > 0 && (
          <>
            <Heading tone="amber" wide={wide}>Stok akhir shift (bahan)</Heading>
            <table className={`w-full ${z.txt}`}>
              <thead>
                <tr className={`${z.th} text-[#6b7280]`}>
                  <th className="px-2 py-1 text-left font-semibold">Bahan</th>
                  <th className="px-2 py-1 text-right font-semibold">Stok</th>
                  <th className="px-2 py-1 text-right font-semibold">Batas min.</th>
                </tr>
              </thead>
              <tbody>
                {p.stock.map((s) => {
                  const low = needsOrder(s);
                  return (
                    <tr key={s.itemId} className={`border-t border-[#e5e7eb] ${low ? "bg-[#fdecef]" : ""}`}>
                      <td className={`px-2 py-1 break-words ${low ? "font-semibold text-[#b91c1c]" : ""}`}>{low ? "⚠ " : ""}{s.name}</td>
                      <td className={`whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums ${low ? "text-[#b91c1c]" : ""}`}>{s.qty == null ? "—" : `${fmt(s.qty)} ${s.unit}`}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[#6b7280]">{fmt(s.limit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <Heading tone="red" wide={wide}>Order bahan baku</Heading>
            {order.length ? (
              <div className={`grid gap-x-4 px-2 ${z.txt} text-[#be123c] ${wide ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"}`}>
                {order.map((o) => <div key={o.itemId} className="break-words">⚠ {o.name} — {fmt(o.qty!)}/{fmt(o.limit)} {o.unit}</div>)}
              </div>
            ) : (
              <div className={`px-2 ${z.small} text-[#6b7280]`}>Semua bahan di atas limit</div>
            )}
          </>
        )}

        {(p.complaints || p.followUp) && (
          <div className={`rounded-lg bg-[#ffffff] p-3 ${z.txt}`}>
            {p.complaints && (<><div className="font-bold">CATATAN / KENDALA</div><div className="text-[#4b5563]">{p.complaints}</div></>)}
            {p.followUp && <div className="mt-1 text-[#4b5563]"><b>Tindak lanjut ({p.followUpStatus}):</b> {p.followUp}</div>}
          </div>
        )}
    </>
    );
  };
  return (
    <>
      {/* Tampilan di layar (seperti semula, tanpa kop surat) */}
      <div className="theme-light overflow-hidden rounded-xl border border-[#e5e7eb] bg-[#fffbe8] text-[#1f2937]">
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
            {sum}
          </div>
          {body(false)}
          <div className="pt-4 text-xs text-[#6b7280]">Dibuat dari Laporan Shift • {photos} foto bukti</div>
        </div>
      </div>
      {/* Versi ber-kop surat untuk unduhan JPG */}
      <DocExport>
        <DocSheet
          id="report-preview" lh={p.lh} exportWidth={1080} className="report-doc" eyebrow="Standar kinerja operasional" title="Laporan Penutup Shift" subtitle={`${label} • ${p.shift}`}
          meta={{ label: `PIC Divisi: ${p.pic}`, value: fmtLong(p.date) }} signer={`PIC ${p.division}`} signDate={p.date}
          notes={[`Dibuat dari Laporan Shift • ${photos} foto bukti.`, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
        >
          <div className="space-y-3 text-[#1f2937] report-jpg">
            {sum}
            {body(true)}
          </div>
        </DocSheet>
      </DocExport>
    </>
  );
}

/** Bagian katalog (mis. Giftbox, Patung, Patung mix): kartu per Tipe+Paket berisi series, angka, dan total grup */
function WorkGroups({ b, wide }: { b: Extract<WorkBlock, { kind: "groups" }>; wide: boolean }) {
  return (
    <div className="py-1">
      <div className={`mb-1 flex flex-wrap items-baseline justify-between gap-x-3 font-bold text-[#1f2937] ${wide ? "text-[30px]" : ""}`}>
        <span>{b.title}</span>
        <span>TOTAL {fmt(b.total)} {b.unit}</span>
      </div>
      {b.groups.length === 0 ? (
        <div className="text-[#9ca3af]">—</div>
      ) : (
        <div className={`grid gap-2 ${wide ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}>
          {b.groups.map((g) => (
            <div key={g.name} className={`rounded-md border border-[#e5e7eb] bg-[#ffffff] px-2.5 py-1.5 ${wide ? "text-[26px]" : ""}`}>
              {g.name && <div className={`mb-0.5 font-bold text-[#1e4f8a] ${wide ? "text-[24px]" : "text-xs"}`}>{g.name}</div>}
              <table className="w-full">
                <tbody>
                  {g.items.map((it) => (
                    <tr key={it.label}>
                      <td className="py-px pr-2">{it.label}</td>
                      <td className="whitespace-nowrap py-px text-right font-semibold tabular-nums">
                        {it.value == null ? "—" : fmt(it.value)}
                        {b.showPcs && it.pcs !== it.value && <span className="font-normal text-[#6b7280]"> ({fmt(it.pcs)})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={`mt-1 flex justify-between border-t border-[#e5e7eb] pt-1 font-bold ${wide ? "text-[24px]" : "text-xs"}`}>
                <span>Total</span>
                <span className="tabular-nums">{fmt(g.total)}{b.showPcs ? " patung" : ""}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Heading({ tone, wide, children }: { tone: "blue" | "amber" | "red"; wide?: boolean; children: React.ReactNode }) {
  const c = { blue: "bg-[#eaf4fd] text-[#1e4f8a]", amber: "bg-[#fdf1cf] text-[#8a5a00]", red: "bg-[#fde2e7] text-[#be123c]" }[tone];
  return <div className={`rounded-lg px-3 py-2 font-bold uppercase ${wide ? "text-[28px]" : "text-sm"} ${c}`}>{children}</div>;
}
