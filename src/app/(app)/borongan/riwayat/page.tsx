import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dateOnly, fmtDay } from "@/lib/time";
import { STATE_LABEL, shipmentViews } from "@/lib/boronganFlow";
import { HANDOVER_LABEL } from "@/lib/borongan";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { canSeeHistory } from "./access";

export const metadata = { title: "Riwayat pengiriman borongan" };
const f = (n: number) => n.toLocaleString("id-ID");
const TONE = { DI_PEKERJA: "amber", SEBAGIAN: "amber", SELESAI: "green" } as const;

/** Riwayat kiriman borongan: dikirim / diterima / reject / selisih per kiriman, plus serah terima alur lama */
export default async function RiwayatPage() {
  const user = await requirePerm("borongan.view", "borongan.point", "borongan.manage");
  if (!(await canSeeHistory(user))) notFound();
  const [list, old] = await Promise.all([
    shipmentViews({}, 300),
    prisma.boronganHandover.findMany({ where: { kind: "KIRIM" }, include: { point: true, lines: true }, orderBy: { date: "desc" }, take: 200 }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Riwayat pengiriman" subtitle="Ketuk nomor kiriman untuk melihat pembagian, setoran per pekerja, pengambilan, dan selisih" />
      {!list.length ? <Empty title="Belum ada kiriman alur baru" /> : (
        <div className="table-wrap">
          <Paged>
            <table className="tbl">
              <thead><tr><th>Kiriman</th><th>Tanggal</th><th>Titik · pekerjaan</th><th className="text-right">Dikirim</th><th className="text-right">Diterima</th><th className="text-right">Reject</th><th className="text-right">Selisih</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td><Link href={`/borongan/riwayat/${s.id}`} className="font-mono text-xs font-semibold text-brand-700 underline">{s.number}</Link></td>
                    <td>{fmtDay(dateOnly(s.date))}</td>
                    <td className="!whitespace-normal">{s.points.map((p) => p.name).join(", ")} · {s.group}</td>
                    <td className="text-right tabular-nums">{f(s.totals.sent)}</td>
                    <td className="text-right tabular-nums">{f(s.totals.received)}</td>
                    <td className="text-right tabular-nums">{f(s.totals.reject)}</td>
                    <td className="text-right tabular-nums">{s.totals.gap == null ? <span className="text-slate-400">—</span> : s.totals.gap ? <b className="text-rose-700">−{f(s.totals.gap)}</b> : "0"}</td>
                    <td>{s.cancelled ? <Badge tone="gray">Dibatalkan</Badge> : <Badge tone={TONE[s.state]}>{STATE_LABEL[s.state]}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Paged>
        </div>
      )}
      {old.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Alur lama (serah terima)</h2>
          <div className="table-wrap">
            <Paged>
              <table className="tbl">
                <thead><tr><th>Nomor</th><th>Tanggal</th><th>Titik</th><th>Jenis</th><th className="text-right">Baris barang</th><th>Status</th></tr></thead>
                <tbody>
                  {old.map((h) => (
                    <tr key={h.id}>
                      <td className="font-mono text-xs">{h.number}</td>
                      <td>{fmtDay(h.date)}</td>
                      <td>{h.point.name}</td>
                      <td>{HANDOVER_LABEL[h.kind]}</td>
                      <td className="text-right tabular-nums">{h.lines.length}</td>
                      <td><Badge tone={h.status === "DITERIMA" ? "green" : h.status === "DIBATALKAN" ? "gray" : "amber"}>{h.status === "DITERIMA" ? "Diterima" : h.status === "DIBATALKAN" ? "Dibatalkan" : "Belum diterima"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          </div>
        </section>
      )}
    </div>
  );
}
