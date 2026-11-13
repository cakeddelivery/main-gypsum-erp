import { notFound } from "next/navigation";
import { pendingDeliveries } from "@/lib/purchaseReceive";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime, fmtDay } from "@/lib/time";
import { STAGE_LABEL } from "@/lib/stock";
import { flowLines, isTemplate, plannedFlow, toEntries, type StockCountRow, type WorkData } from "@/lib/shiftReport";
import { boronganLines } from "@/lib/shiftReportBorongan";
import { flowEnabled } from "@/lib/shiftReportFlow";
import { RESULT_COUNT, resultCountStatus, resultLines, resultValues } from "@/lib/shiftResultCount";
import { VARIANTS } from "@/lib/shiftReport";
import { divisionPendingReturns } from "@/lib/borongan";
import { confirmReturnForReport } from "../actions";
import Link from "next/link";
import { Suspense } from "react";
import { canFollowUp, canSeeDivision, reportDivision } from "@/lib/reportScope";
import { ModalForm } from "@/components/ModalForm";
import { saveFollowUp } from "../actions";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { Modal } from "@/components/Modal";
import { ClearQuery } from "@/components/ClearQuery";
import { ReportForm, ReceiptSection } from "./ReportForm";
import { ReportSheet } from "./ReportSheet";
import { reportCatalogs } from "@/lib/productFamily";
import { letterhead } from "@/lib/letterhead";

export const metadata = { title: "Laporan Penutup Shift" };

export default async function ReportDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ isi?: string; masuk?: string; jpg?: string }> }) {
  const user = await requirePerm("report.view");
  const { id } = await params;
  const { isi, masuk, jpg } = await searchParams;
  const r = await prisma.shiftReport.findUnique({ where: { id }, include: { shift: true, division: true, sends: { orderBy: { sentAt: "desc" } } } });
  if (!r) notFound();
  // Karyawan hanya boleh membuka laporan divisinya sendiri (ditegakkan di server)
  if (!canSeeDivision(user, r.divisionId)) notFound();
  const template = isTemplate(r.division.reportTemplate) ? r.division.reportTemplate : null;
  const [entries, people] = await Promise.all([
    template ? Promise.resolve([]) : prisma.productionEntry.groupBy({ by: ["stage"], where: { date: r.date, shiftId: r.shiftId, divisionId: r.divisionId }, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.employee.findMany({ where: { divisionId: r.divisionId, status: "AKTIF" }, orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  const checklist = toEntries(r.checklist);
  const catalogs = await reportCatalogs(template);
  const saved = r.stockCount as StockCountRow[];
  // Saat diisi: daftar bahan mengikuti master bahan baku divisi terkini (hitungan yang sudah ada dipertahankan)
  const items = await prisma.item.findMany({ where: { divisionId: r.divisionId, active: true, type: "BAHAN_BAKU" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const editStock: StockCountRow[] = items.map((i) => ({ itemId: i.id, name: i.name, unit: i.unit, limit: Number(i.minStock), qty: saved.find((x) => x.itemId === i.id)?.qty ?? null }));
  const stock = saved;
  const work = r.work as WorkData;
  // Anggota divisi tidak bisa mengubah laporan yang sudah terkirim (Supervisor/Admin/Owner tetap bisa)
  const locked = r.status !== "DRAFT" && reportDivision(user) !== null;
  const canEdit = user.can("report.create") && !locked;
  const day = r.date.toISOString().slice(0, 10);
  const lh = await letterhead();
  const [bLines, flowOn, resultStatus, receipts, pendingReturns] = await Promise.all([
    boronganLines(template, r.date),
    flowEnabled(),
    resultCountStatus(r.id),
    prisma.shiftReceipt.findMany({ where: { reportId: r.id }, include: { item: true }, orderBy: { number: "asc" } }),
    divisionPendingReturns(r.divisionId),
  ]);
  // Pesanan dalam pengiriman untuk bahan divisi ini (validasi barang datang lewat barang masuk)
  // Rekomendasi barang masuk: pesanan bahan divisi yang sedang dalam perjalanan. Pesanan COD (bayar di tempat)
  // hanya untuk yang berwenang Terima barang; yang sudah dibayar boleh dipilih semua yang mengisi laporan.
  const canReceive = user.can("stock.receive");
  const [pend, bankRows] = canEdit ? await Promise.all([pendingDeliveries(prisma, items.map((i) => i.id)), prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } })]) : [[], []];
  const orders = pend.filter((p) => canReceive || !p.cod).flatMap((p) => p.lines.filter((l) => items.some((i) => i.id === l.itemId) && Number(l.qty) - Number(l.qtyReceived) > 0.0005).map((l) => {
    const remaining = Number(l.qty) - Number(l.qtyReceived);
    return { lineId: l.id, itemId: l.itemId, remaining, cod: p.cod, vendor: p.vendor, itemName: l.item.name, unit: l.item.unit, label: `${p.number} · ${p.vendor} · sisa ${remaining.toLocaleString("id-ID")} ${l.item.unit}${p.cod ? " · COD" : ""}` };
  }));
  const banks = [...bankRows].sort((a, b) => (a.code === "KAS" ? -1 : b.code === "KAS" ? 1 : 0)).map((b) => ({ id: b.id, name: b.name }));
  const extraLines = [...bLines, ...(resultStatus ? resultLines(resultStatus) : [])];
  const resultDef = template ? RESULT_COUNT[template] : undefined;
  const rv = resultValues(work);
  const receiptLines = receipts.map((x) => `${x.item.name}: ${Number(x.qty).toLocaleString("id-ID")} ${x.item.unit}${x.supplierName ? ` · ${x.supplierName}` : ""}${x.purchaseId ? "" : " (belum dicatat di Pembelian)"}`);
  const flow = flowOn && template ? flowLines(plannedFlow(template, work)) : [];
  const fname = `laporan-${r.division.code}-${r.shift.code}-${day}`;
  // Pratinjau JPG & Unduh JPG hanya setelah laporan dikirim (saat mengisi tidak ditampilkan)
  const sent = r.status !== "DRAFT";
  const receiptViews = receipts.map((x) => ({ id: x.id, number: x.number, itemName: x.item.name, unit: x.item.unit, qty: Number(x.qty), supplierName: x.supplierName, hasPhoto: !!x.photoPath, linked: !!x.purchaseId }));
  const materials = items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }));

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Laporan ${r.division.name}`}
        subtitle={`${r.shift.name} · ${fmtDay(r.date)}`}
        actions={
          <>
            {canEdit && (
              <Modal
                full
                defaultOpen={isi === "1"}
                trigger={r.status === "DRAFT" ? "✏️ Lanjutkan isi laporan" : "✏️ Ubah laporan"}
                title={`Laporan ${r.division.name}`}
                subtitle={`${r.shift.name} · ${fmtDay(r.date)}`}
              >
                <ReportForm
                  id={r.id}
                  template={template}
                  picName={user.username}
                  work={work}
                  checklist={checklist}
                  stock={editStock}
                  people={people.map((p) => p.name)}
                  complaints={r.complaints ?? ""}
                  followUp={r.followUp ?? ""}
                  followUpStatus={r.followUpStatus}
                  receipts={receiptViews}
                  materials={materials}
                  orders={orders}
                  banks={banks}
                  applied={r.stockApplied}
                  resultTitle={resultDef?.title ?? null}
                  catalogs={catalogs}
                  resultCount={resultDef ? VARIANTS.map((v) => ({ key: v, label: `${resultDef.label} ${v}`, unit: resultDef.unit, qty: rv[v] ?? null })) : []}
                  flow={flowOn && template ? flow : null}
                  sent={r.workPostedVersion > 0 || r.status !== "DRAFT"}
                />
              </Modal>
            )}
            {canEdit && (
              <Modal trigger={`+ Barang masuk${receipts.length ? ` (${receipts.length})` : ""}`} triggerClass="btn-secondary" title="Barang masuk hari ini" subtitle={`${r.division.name} · ${r.shift.name} · ${fmtDay(r.date)}`} defaultOpen={masuk === "1"} wide>
                {materials.length > 0 ? (
                  <ReceiptSection id={r.id} receipts={receiptViews} materials={materials} applied={r.stockApplied} orders={orders} banks={banks} />
                ) : (
                  <p className="text-sm text-slate-600">{r.division.name} belum punya daftar bahan baku. Minta Admin mengisi bahan divisi di Laporan Shift › Bahan & checklist divisi.</p>
                )}
              </Modal>
            )}

          </>
        }
      />
      {canEdit && (
        <div className="space-y-4">
          <Suspense fallback={null}><ClearQuery param="isi" /><ClearQuery param="masuk" /></Suspense>
          {template === "ASSEMBLING" && (
            <div className="card p-4 text-sm">
              <h3 className="mb-1 font-semibold text-slate-800">Setoran borongan hari ini</h3>
              {bLines.length ? <ul className="text-slate-600">{bLines.slice(1).map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-slate-500">Belum ada setoran tercatat untuk tanggal ini.</p>}
              {user.can("borongan.view") && <Link href="/borongan" className="btn-secondary btn-sm mt-2">Catat setoran / kirim bahan di menu Borongan</Link>}
            </div>
          )}
          {pendingReturns.length > 0 && (
            <div className="card p-4 text-sm">
              <h3 className="mb-1 font-semibold text-slate-800">Kiriman hasil borongan menunggu diterima</h3>
              <p className="mb-2 text-xs text-slate-500">Hitung barangnya, lalu tekan Terima SEBELUM menghitung stok akhir agar tidak dobel.</p>
              <ul className="divide-y divide-slate-100">
                {pendingReturns.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <div><b>{h.point.name}</b> · {fmtDay(h.date)}{h.driver && ` · driver ${h.driver.name}`}<ul className="text-xs text-slate-600">{h.lines.map((l) => <li key={l.id}>{l.item.name}: {Number(l.qty).toLocaleString("id-ID")} {l.item.unit}</li>)}</ul></div>
                    <ActionForm action={confirmReturnForReport} confirm="Barang sudah diterima lengkap?"><input type="hidden" name="id" value={h.id} /><input type="hidden" name="reportId" value={r.id} /><Submit className="btn-success btn-sm" pendingText="…">Terima</Submit></ActionForm>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {locked && isi === "1" && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">✓ Laporan shift ini sudah terkirim, jadi tidak bisa diubah lagi. Bila ada yang salah, minta Supervisor/Admin mengubahnya.</p>
      )}
      {!sent ? (
        <div className="card p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="amber">Draf</Badge><span className="text-slate-500">Dibuat oleh {r.createdBy} · PIC {r.picName ?? r.createdBy}</span></div>
          <p className="mt-3 text-slate-600">Laporan belum dikirim. Lanjutkan mengisi lewat tombol <b>Lanjutkan isi laporan</b>, lalu tekan <b>Kirim laporan</b> di langkah terakhir. Pratinjau & JPG laporan muncul setelah terkirim.</p>
          <ul className="mt-3 grid gap-1 text-slate-600 sm:grid-cols-3">
            <li>Checklist: <b>{checklist.filter((c) => (c.photo ? !!c.photoPath : c.done)).length}/{checklist.length}</b></li>
            <li>Barang masuk: <b>{receipts.length}</b></li>
            <li>Stok akhir terisi: <b>{saved.filter((x) => x.qty != null).length}/{editStock.length}</b></li>
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <Suspense fallback={null}><ClearQuery param="jpg" /></Suspense>
          <div className="card mx-auto max-w-3xl p-5 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={r.status === "TERKIRIM" ? "green" : "purple"}>{r.status === "TERKIRIM" ? "Terkirim" : "Direvisi"}</Badge><span className="text-slate-500">PIC {r.picName ?? r.createdBy}</span></div>
            <ul className="mt-3 grid gap-1 text-slate-600 sm:grid-cols-3">
              <li>Nilai checklist: <b>{checklist.length ? Math.round((checklist.filter((c) => (c.photo ? !!c.photoPath : c.done)).length / checklist.length) * 100) : 100}</b></li>
              <li>Barang masuk: <b>{receipts.length}</b></li>
              <li>Stok akhir: <b>{saved.filter((x) => x.qty != null).length}/{saved.length}</b></li>
            </ul>
            {r.complaints && (
              <div className={`mt-3 rounded-lg p-3 ${r.followUpStatus === "SELESAI" ? "bg-slate-50" : "bg-rose-50"}`}>
                <p className="font-medium text-slate-800">Kendala: <span className="font-normal">{r.complaints}</span></p>
                <p className="mt-1 text-xs text-slate-600">Tindak lanjut: {r.followUp || "—"} · <b>{r.followUpStatus === "SELESAI" ? "Selesai" : r.followUpStatus === "PROSES" ? "Proses" : "Belum"}</b></p>
                {canFollowUp(user) && (
                  <Modal trigger="Tindak lanjuti" triggerClass="btn-secondary btn-sm mt-2" title="Tindak lanjut kendala" subtitle={`${r.division.name} · ${r.shift.name} · ${fmtDay(r.date)}`}>
                    <ModalForm action={saveFollowUp} className="space-y-3">
                      <input type="hidden" name="id" value={r.id} />
                      <p className="rounded-lg bg-slate-50 p-2 text-sm">Kendala: {r.complaints}</p>
                      <label className="block"><span className="label">Tindak lanjut</span><textarea name="followUp" defaultValue={r.followUp ?? ""} className="input" rows={3} required /></label>
                      <label className="block"><span className="label">Status</span>
                        <select name="followUpStatus" defaultValue={r.followUpStatus} className="input"><option value="BELUM">Belum</option><option value="PROSES">Proses</option><option value="SELESAI">Selesai</option></select>
                      </label>
                      <Submit>Simpan tindak lanjut</Submit>
                    </ModalForm>
                  </Modal>
                )}
              </div>
            )}
            <div className="mt-4"><DownloadJpg targetId="report-preview" filename={fname} autoOpen={jpg === "1"} label="🖼️ Lihat & unduh JPG" className="btn-primary" /></div>
          </div>
          <div className="hidden" aria-hidden>{/* Sumber gambar JPG; ditampilkan lewat popup pratinjau */}
            <ReportSheet
              lh={lh}
              id={r.id}
              date={day}
              division={r.division.name}
              shift={r.shift.name}
              pic={r.picName ?? r.createdBy}
              template={template}
              work={work}
              checklist={checklist}
              stock={stock}
              complaints={r.complaints}
              followUp={r.followUp}
              followUpStatus={r.followUpStatus}
              extraLines={extraLines}
              receiptLines={receiptLines}
              target={r.division.targetPerShift}
              legacyLines={entries.map((e) => `${STAGE_LABEL[e.stage]}: ${e._sum.qtyGood ?? 0} pcs (reject ${e._sum.qtyReject ?? 0})`)}
            />
          </div>
          {r.sends.length > 0 && (
            <details className="card mx-auto max-w-3xl p-4 text-sm">
              <summary className="cursor-pointer font-medium text-slate-700">Riwayat pengiriman ({r.sends.length}) · terakhir {fmtDateTime(r.sends[0].sentAt)}</summary>
              <ul className="mt-3 space-y-2">
                {r.sends.map((s) => (
                  <li key={s.id} className="flex justify-between gap-2">
                    <span>{fmtDateTime(s.sentAt)} · {s.sentBy} <span className="text-xs text-slate-400">({s.channel})</span>{s.error && <span className="block text-xs text-rose-500">{s.error}</span>}</span>
                    <Badge tone={s.status === "TERKIRIM" ? "green" : s.status === "GAGAL" ? "red" : "amber"}>{s.status}</Badge>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
