import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { reportDivision } from "@/lib/reportScope";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, fmtDate, todayStr } from "@/lib/time";
import { Badge, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { isDone, needsOrder, toEntries, type StockCountRow } from "@/lib/shiftReport";
import { Modal } from "@/components/Modal";
import { ReportStartForm } from "@/components/ReportStartForm";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Laporan Shift" };

const STATUS: Record<string, { label: string; tone: "green" | "purple" | "amber" }> = {
  DRAFT: { label: "Draf", tone: "amber" },
  TERKIRIM: { label: "Terkirim", tone: "green" },
  DIREVISI: { label: "Direvisi", tone: "purple" },
};
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Daftar laporan penutup shift. Form isian tidak pernah terbuka di halaman:
 * "+ Kirim laporan" membuka popup pilih tanggal/divisi/shift, lalu form lengkap terbuka di popup layar penuh.
 */
export default async function LaporanPage({ searchParams }: { searchParams: Promise<{ dari?: string; sampai?: string; divisi?: string; status?: string; kendala?: string }> }) {
  const user = await requirePerm("report.view");
  const q = await searchParams;
  const today = todayStr();
  const to = isDate(q.sampai) ? q.sampai! : today;
  const from = isDate(q.dari) ? q.dari! : addDays(to, q.kendala ? -14 : -6);
  const fixedDivision = reportDivision(user);
  const divFilter = fixedDivision ?? (q.divisi || undefined);
  const statusFilter = q.status && STATUS[q.status] ? q.status : undefined;
  const [shifts, divisions, reports] = await Promise.all([
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.division.findMany({ where: { active: true, ...(fixedDivision ? { id: fixedDivision } : {}) }, orderBy: { code: "asc" } }),
    prisma.shiftReport.findMany({
      where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(divFilter ? { divisionId: divFilter } : {}), ...(statusFilter ? { status: statusFilter as never } : {}), ...(q.kendala ? { complaints: { not: null }, NOT: [{ complaints: "" }, { followUpStatus: "SELESAI" }] } : {}) },
      include: { shift: true, division: true },
      orderBy: [{ date: "desc" }, { division: { code: "asc" } }, { shift: { code: "asc" } }],
      take: 300,
    }),
  ]);
  // Draf yang belum terkirim tampil paling atas agar mudah dilanjutkan
  const rows = [...reports].sort((a, b) => Number(a.status !== "DRAFT") - Number(b.status !== "DRAFT"));
  const drafts = reports.filter((r) => r.status === "DRAFT").length;
  // Ringkasan hari ini: berapa slot divisi × shift yang sudah terkirim
  const todayReports = await prisma.shiftReport.findMany({ where: { date: dateOnly(today), ...(fixedDivision ? { divisionId: fixedDivision } : {}) }, select: { status: true } });
  const slots = divisions.reduce((n, d) => n + Math.min(Math.max(1, d.shiftCount), shifts.length), 0);
  const sentToday = todayReports.filter((r) => r.status !== "DRAFT").length;
  const canCreate = user.can("report.create") && divisions.length > 0;

  const startData = { auto: fixedDivision !== null, today, divisions: divisions.map((d) => ({ id: d.id, name: d.name, shiftCount: d.shiftCount })), shifts: shifts.map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime })) };
  const newForm = canCreate && (
    <>
      <Modal trigger="+ Kirim laporan" title="Kirim laporan shift"><ReportStartForm data={startData} /></Modal>
      <Modal trigger="+ Barang masuk" triggerClass="btn-secondary" title="Catat barang masuk"><ReportStartForm data={startData} go="masuk" /></Modal>
    </>
  );

  return (
    <div>
      <PageHeader
        title="Laporan shift"
        subtitle={<>Hari ini {sentToday}/{slots} laporan terkirim{drafts > 0 && <> · <span className="font-medium text-amber-700">{drafts} draf belum dikirim</span></>}</>}
        actions={
          <>
            {newForm}
            <Link href="/laporan/order" className="btn-secondary">Order bahan baku</Link>
            <Link href="/laporan/rekap" className="btn-secondary">Rekap</Link>
            <Link href="/laporan/monitoring" className="btn-secondary">Resi &amp; patung</Link>
            {user.can("material.manage") && <Link href="/laporan/bahan" className="btn-secondary">Bahan & checklist divisi</Link>}
          </>
        }
      />
      <FilterBar>
        <Field label="Dari"><input type="date" name="dari" defaultValue={from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="sampai" defaultValue={to} className="input" /></Field>
        {!fixedDivision && (
          <Field label="Divisi">
            <select name="divisi" defaultValue={q.divisi ?? ""} className="input">
              <option value="">Semua</option>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Status">
          <select name="status" defaultValue={statusFilter ?? ""} className="input">
            <option value="">Semua</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        {q.kendala && <input type="hidden" name="kendala" value="1" />}
      </FilterBar>
      {q.kendala && <p className="mb-3 text-sm text-rose-700">Menampilkan laporan dengan kendala yang belum selesai ditindaklanjuti. <a href="/laporan" className="link">Tampilkan semua</a></p>}
      {rows.length === 0 ? (
        <Empty title="Belum ada laporan di periode ini" hint={canCreate ? "Tekan + Kirim laporan untuk mengisi laporan penutup shift." : undefined} />
      ) : (
        <div className="table-wrap">
          <Paged>
            <table className="tbl">
              <thead>
                <tr><th>Tanggal</th><th>Status</th><th>Divisi · shift</th><th>PIC</th><th>Checklist</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS[r.status] ?? STATUS.DRAFT;
                  const cl = toEntries(r.checklist);
                  const low = (r.stockCount as StockCountRow[]).filter(needsOrder).length;
                  const draft = r.status === "DRAFT";
                  return (
                    <tr key={r.id}>
                      <td>{fmtDate(r.date)}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge>{r.complaints && r.followUpStatus !== "SELESAI" && <span className="mt-1 block"><Badge tone="red">Kendala</Badge></span>}</td>
                      <td>{r.division.name}<span className="block text-xs text-slate-500">{r.shift.name}</span></td>
                      <td>{r.picName ?? r.createdBy}</td>
                      <td className="text-xs text-slate-500">{cl.filter(isDone).length}/{cl.length}{low > 0 && <span className="block text-rose-600">{low} bahan perlu order</span>}</td>
                      <td>
                        {draft && user.can("report.create") ? (
                          <Link href={`/laporan/${r.id}?isi=1`} className="btn-primary btn-sm">Lanjutkan</Link>
                        ) : (
                          <Link href={`/laporan/${r.id}`} className="btn-secondary btn-sm">Lihat</Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Paged>
        </div>
      )}
    </div>
  );
}
