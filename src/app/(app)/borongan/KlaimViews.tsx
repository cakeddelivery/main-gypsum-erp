import type { ClaimBreakdown, ClaimPerson } from "@/lib/boronganClaim";
import { shortTaskName } from "@/lib/boronganFlow";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const f = (n: number) => n.toLocaleString("id-ID");
export const CLAIM_STATUS_LABEL = { MENUNGGU: "menunggu Finance / Owner", DIBAYAR: "dibayar", DITOLAK: "ditolak" } as const;
export const CLAIM_TONE = { MENUNGGU: "amber", DIBAYAR: "green", DITOLAK: "red" } as const;
/** Status di kepala dokumen pengajuan klaim */
export const CLAIM_DOC_STATUS = { DRAF: "Draf (belum diajukan)", MENUNGGU: "Diajukan ke Finance", DIBAYAR: "Disetujui & dibayar", DITOLAK: "Ditolak" } as const;

/**
 * Rincian klaim upah: Pekerja (per orang per pekerjaan), Koordinator, Fee driver (selalu ada), Total.
 * `doc` = gaya dokumen ber-kop (JPG/PDF, selalu terang); selain itu tabel HP dengan geser di dalam kartu.
 */
export function ClaimTable({ b, doc, workerOnly }: { b: ClaimBreakdown; doc?: boolean; /** Dokumen per pekerja: hanya fee pekerja itu */ workerOnly?: boolean }) {
  const label = (person: ClaimPerson, l: ClaimPerson["lines"][number], showName: boolean) => (showName ? `${person.name} · ${niceTask(l.label)}` : l.label);
  const group = (title: string, people: ClaimPerson[], total: number, totalLabel: string, showName: boolean, empty?: string) => [
    <tr key={`g-${title}`} className={doc ? "claim-grp" : "bg-slate-100"}><td colSpan={4} className={doc ? "" : "px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-600"}>{title}</td></tr>,
    ...(people.length ? people.flatMap((p) => [
      ...p.lines.map((l, i) => (
        <tr key={`${title}-${p.id}-${i}`} className={doc ? "" : "border-t border-slate-100"}>
          <td className={doc ? "" : "px-2 py-1.5"}>{label(p, l, showName)}</td>
          <td className={doc ? "num" : "whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums"}>{f(l.qty)}</td>
          <td className={doc ? "num" : "whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums"}>{rp(l.rate)}</td>
          <td className={doc ? "num" : "whitespace-nowrap px-2 py-1.5 text-right tabular-nums"}>{rp(l.amount)}</td>
        </tr>
      )),
      ...(showName && p.lines.length > 1 ? [<tr key={`${title}-${p.id}-sub`} className={doc ? "claim-sub" : "border-t border-slate-200 font-semibold"}><td className={doc ? "" : "px-2 py-1.5"}>{p.name}</td><td /><td /><td className={doc ? "num" : "whitespace-nowrap px-2 py-1.5 text-right tabular-nums"}>{rp(p.total)}</td></tr>] : []),
    ]) : [<tr key={`${title}-empty`}><td colSpan={4} className={doc ? "doc-empty" : "px-3 py-1.5 text-sm text-slate-500"}>{empty ?? "—"}</td></tr>]),
    <tr key={`${title}-total`} className={doc ? "claim-sub" : "border-t-2 border-slate-200 font-bold"}><td className={doc ? "" : "px-2 py-1.5"}>{totalLabel}</td><td /><td /><td className={doc ? "num" : "whitespace-nowrap px-2 py-1.5 text-right tabular-nums"}>{rp(total)}</td></tr>,
  ];
  const driverTitle = b.drivers.filter((d) => d.id !== "-").length === 1 ? `Fee driver · ${b.drivers.find((d) => d.id !== "-")!.name}` : "Fee driver";
  const body = (
    <>
      <thead>
        <tr className={doc ? "" : "bg-slate-50 text-xs text-slate-500"}>
          <th className={doc ? "" : "px-2 py-1.5 text-left font-semibold"}>Penerima · pekerjaan</th>
          <th className={doc ? "num" : "px-1.5 py-1.5 text-right font-semibold"}>Jumlah</th>
          <th className={doc ? "num" : "px-1.5 py-1.5 text-right font-semibold"}>{doc ? "Upah satuan" : "Satuan"}</th>
          <th className={doc ? "num" : "px-2 py-1.5 text-right font-semibold"}>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        {workerOnly ? group("Pekerja", b.workers, b.totals.workers, "", false, "Belum ada setoran").slice(0, -1) : group("Pekerja", b.workers, b.totals.workers, "Total pekerja", true)}
        {!workerOnly && group("Koordinator", b.coordinators, b.totals.coordinators, "Total koordinator", b.coordinators.length > 1, "Tanpa koordinator (Rp0)")}
        {!workerOnly && group(driverTitle, b.drivers, b.totals.drivers, "Total fee driver", b.drivers.length > 1, "Tidak ada fee driver (Rp0)")}
        <tr className={doc ? "claim-grand" : "bg-brand-50 text-base font-bold text-brand-800"}><td className={doc ? "" : "px-2 py-2"}>{workerOnly ? `Total fee ${b.workers[0]?.name ?? "pekerja"}` : "Total klaim"}</td><td /><td /><td className={doc ? "num" : "whitespace-nowrap px-2 py-2 text-right tabular-nums"}>{rp(b.totals.all)}</td></tr>
      </tbody>
    </>
  );
  if (doc) return <div className="doc-table claim-doc"><table>{body}</table></div>;
  return <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-[13px] leading-snug">{body}</table></div>;
}

/** "Cat giftbox" → "Cat Giftbox", "Assembling Transportasi" → "Assembling Transport" */
function niceTask(task: string) {
  const s = shortTaskName(task);
  const group = task.slice(0, task.length - task.split(" ").pop()!.length).trim();
  return s.startsWith("Cat ") || !group ? s : `${group.charAt(0).toUpperCase()}${group.slice(1)} ${s}`;
}
