import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime, fmtDay } from "@/lib/time";
import { STAGE_LABEL } from "@/lib/stock";
import { ATT_LABEL } from "@/lib/attendance";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { saveReport, sendReport } from "../actions";

export const metadata = { title: "Detail Laporan Shift" };

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("report.view");
  const { id } = await params;
  const r = await prisma.shiftReport.findUnique({ where: { id }, include: { shift: true, division: true, sends: { orderBy: { sentAt: "desc" } } } });
  if (!r) notFound();
  const [entries, attendance] = await Promise.all([
    prisma.productionEntry.findMany({ where: { date: r.date, shiftId: r.shiftId, divisionId: r.divisionId }, include: { employee: true, product: true }, orderBy: [{ stage: "asc" }, { employeeId: "asc" }] }),
    prisma.attendance.findMany({ where: { date: r.date, shiftId: r.shiftId, employee: { divisionId: r.divisionId } }, include: { employee: true } }),
  ]);
  const checklist = r.checklist as { label: string; done: boolean }[];
  const canEdit = user.can("report.create") && !(user.role === "KAPTEN_DIVISI" && user.divisionId !== r.divisionId);
  const good = entries.reduce((s, e) => s + e.qtyGood, 0);
  const reject = entries.reduce((s, e) => s + e.qtyReject, 0);
  const fname = `laporan-${r.division.code}-${r.shift.code}-${r.date.toISOString().slice(0, 10)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Laporan ${r.division.name}`}
        subtitle={`${r.shift.name} · ${fmtDay(r.date)}`}
        actions={
          <>
            <Link href={`/laporan?date=${r.date.toISOString().slice(0, 10)}`} className="btn-secondary">← Kembali</Link>
            <DownloadJpg targetId="report-preview" filename={fname} />
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div id="report-preview" className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-brand-600">Main Gypsum · Laporan Shift</div>
                <div className="text-lg font-semibold">{r.division.name} — {r.shift.name}</div>
                <div className="text-sm text-slate-500">{fmtDay(r.date)} · {r.shift.startTime}–{r.shift.endTime} WIB</div>
              </div>
              <Badge tone={r.status === "TERKIRIM" ? "green" : "amber"}>{r.status}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Hasil</div><div className="text-lg font-semibold">{good}</div></div>
              <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Reject</div><div className="text-lg font-semibold text-rose-600">{reject}</div></div>
              <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Hadir</div><div className="text-lg font-semibold">{attendance.filter((a) => a.status === "HADIR" || a.status === "TERLAMBAT").length}</div></div>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-1">Karyawan</th><th>Tahap</th><th>Produk</th><th className="text-right">Hasil</th><th className="text-right">Reject</th></tr></thead>
              <tbody>
                {entries.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-slate-400">Belum ada hasil tercatat</td></tr>}
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100"><td className="py-1">{e.employee.name}</td><td>{STAGE_LABEL[e.stage]}</td><td>{e.product.name}</td><td className="text-right tabular-nums">{e.qtyGood}</td><td className="text-right tabular-nums text-rose-600">{e.qtyReject}</td></tr>
                ))}
              </tbody>
            </table>
            {attendance.length > 0 && (
              <div className="mt-4 text-sm">
                <div className="mb-1 text-xs font-semibold text-slate-500">Absensi</div>
                <div className="flex flex-wrap gap-1.5">{attendance.map((a) => <Badge key={a.id} tone={a.status === "HADIR" ? "green" : a.status === "TERLAMBAT" ? "amber" : "red"}>{a.employee.name}: {ATT_LABEL[a.status]}</Badge>)}</div>
              </div>
            )}
            <div className="mt-4 text-sm">
              <div className="mb-1 text-xs font-semibold text-slate-500">Checklist</div>
              <ul>{checklist.map((c, i) => <li key={i}>{c.done ? "☑" : "☐"} {c.label}</li>)}</ul>
            </div>
            {r.complaints && <div className="mt-3 text-sm"><span className="text-xs font-semibold text-slate-500">Keluhan: </span>{r.complaints}</div>}
            {r.followUp && <div className="mt-1 text-sm"><span className="text-xs font-semibold text-slate-500">Tindak lanjut ({r.followUpStatus}): </span>{r.followUp}</div>}
            <div className="mt-4 text-right text-xs text-slate-400">Dibuat oleh {r.createdBy}</div>
          </div>
        </div>
        <div className="space-y-5 lg:col-span-2">
          {canEdit && (
            <Card title="Checklist, keluhan & tindak lanjut">
              <ActionForm action={saveReport} className="space-y-3">
                <input type="hidden" name="id" value={r.id} />
                {checklist.map((c, i) => (
                  <label key={i} className="flex items-center gap-2 text-sm"><input type="checkbox" name={`check_${i}`} defaultChecked={c.done} className="h-4 w-4" /> {c.label}</label>
                ))}
                <label className="block"><span className="label">Keluhan divisi</span><textarea name="complaints" defaultValue={r.complaints ?? ""} className="input" rows={2} /></label>
                <label className="block"><span className="label">Tindak lanjut</span><textarea name="followUp" defaultValue={r.followUp ?? ""} className="input" rows={2} /></label>
                <label className="block"><span className="label">Status tindak lanjut</span>
                  <select name="followUpStatus" defaultValue={r.followUpStatus} className="input"><option value="BELUM">Belum</option><option value="PROSES">Proses</option><option value="SELESAI">Selesai</option></select>
                </label>
                <Submit>Simpan</Submit>
              </ActionForm>
            </Card>
          )}
          {canEdit && (
            <Card title="Kirim laporan">
              <ActionForm action={sendReport}>
                <input type="hidden" name="id" value={r.id} />
                <p className="mb-3 text-sm text-slate-500">Laporan dikirim ke penerima rekap di Telegram (bila bot aktif) dan tercatat di riwayat.</p>
                <Submit className="btn-success" pendingText="Mengirim…">Kirim laporan</Submit>
              </ActionForm>
            </Card>
          )}
          <Card title="Riwayat pengiriman">
            {r.sends.length === 0 ? <p className="text-sm text-slate-400">Belum pernah dikirim</p> : (
              <ul className="space-y-2 text-sm">
                {r.sends.map((s) => (
                  <li key={s.id} className="flex justify-between gap-2">
                    <span>{fmtDateTime(s.sentAt)} · {s.sentBy} <span className="text-xs text-slate-400">({s.channel})</span>{s.error && <span className="block text-xs text-rose-500">{s.error}</span>}</span>
                    <Badge tone={s.status === "TERKIRIM" ? "green" : s.status === "GAGAL" ? "red" : "amber"}>{s.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
