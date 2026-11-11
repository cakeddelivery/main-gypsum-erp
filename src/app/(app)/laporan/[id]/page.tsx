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
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { sendReport } from "../actions";
import { ReportForm } from "./ReportForm";
import { ReportSheet } from "./ReportSheet";
import { reportCatalogs } from "@/lib/productFamily";
import { letterhead } from "@/lib/letterhead";

export const metadata = { title: "Laporan Penutup Shift" };

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("report.view");
  const { id } = await params;
  const r = await prisma.shiftReport.findUnique({ where: { id }, include: { shift: true, division: true, sends: { orderBy: { sentAt: "desc" } } } });
  if (!r) notFound();
  const ownOnly = user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR";
  if (ownOnly && user.divisionId !== r.divisionId) notFound();
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
  const canEdit = user.can("report.create") && !(ownOnly && user.divisionId !== r.divisionId);
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
  const canReceive = user.can("stock.receive");
  const [pend, bankRows] = canReceive ? await Promise.all([pendingDeliveries(prisma, items.map((i) => i.id)), prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } })]) : [[], []];
  const orders = pend.flatMap((p) => p.lines.filter((l) => items.some((i) => i.id === l.itemId) && Number(l.qty) - Number(l.qtyReceived) > 0.0005).map((l) => {
    const remaining = Number(l.qty) - Number(l.qtyReceived);
    return { lineId: l.id, itemId: l.itemId, remaining, cod: p.cod, label: `${p.number} · ${p.vendor} · sisa ${remaining.toLocaleString("id-ID")} ${l.item.unit}${p.cod ? " · COD" : ""}` };
  }));
  const banks = [...bankRows].sort((a, b) => (a.code === "KAS" ? -1 : b.code === "KAS" ? 1 : 0)).map((b) => ({ id: b.id, name: b.name }));
  const extraLines = [...bLines, ...(resultStatus ? resultLines(resultStatus) : [])];
  const resultDef = template ? RESULT_COUNT[template] : undefined;
  const rv = resultValues(work);
  const receiptLines = receipts.map((x) => `${x.item.name}: ${Number(x.qty).toLocaleString("id-ID")} ${x.item.unit}${x.supplierName ? ` · ${x.supplierName}` : ""}${x.purchaseId ? "" : " (belum dicatat di Pembelian)"}`);
  const flow = flowOn && template ? flowLines(plannedFlow(template, work)) : [];
  const fname = `laporan-${r.division.code}-${r.shift.code}-${day}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Laporan ${r.division.name}`}
        subtitle={`${r.shift.name} · ${fmtDay(r.date)}`}
        actions={
          <>
            <DownloadJpg targetId="report-preview" filename={fname} />
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-5">
        {canEdit && (
          <div className="space-y-4 lg:order-1 lg:col-span-3">
                <>
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
                </>
            <ReportForm
              id={r.id}
              template={template}
              picName={r.picName ?? r.createdBy}
              work={work}
              checklist={checklist}
              stock={editStock}
              people={people.map((p) => p.name)}
              complaints={r.complaints ?? ""}
              followUp={r.followUp ?? ""}
              followUpStatus={r.followUpStatus}
              receipts={receipts.map((x) => ({ id: x.id, number: x.number, itemName: x.item.name, unit: x.item.unit, qty: Number(x.qty), supplierName: x.supplierName, hasPhoto: !!x.photoPath, linked: !!x.purchaseId }))}
              materials={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))}
              orders={orders}
              banks={banks}
              applied={r.stockApplied}
              resultTitle={resultDef?.title ?? null}
              catalogs={catalogs}
              resultCount={resultDef ? VARIANTS.map((v) => ({ key: v, label: `${resultDef.label} ${v}`, unit: resultDef.unit, qty: rv[v] ?? null })) : []}
            />
          </div>
        )}
        <div className={`space-y-5 ${canEdit ? "lg:order-2 lg:col-span-2" : "lg:col-span-3"}`}>
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
          <div className="flex items-center gap-2"><Badge tone={r.status === "TERKIRIM" ? "green" : r.status === "DIREVISI" ? "purple" : "amber"}>{r.status}</Badge><span className="text-xs text-slate-500">Dibuat oleh {r.createdBy}</span></div>
          {canEdit && (
            <Card title="Kirim laporan">
              <ActionForm action={sendReport} confirm="Kirim laporan sekarang? Stok akhir shift akan menjadi stok sistem (stock opname).">
                <input type="hidden" name="id" value={r.id} />
                <p className="mb-3 text-sm text-slate-500">Simpan dulu isian laporan. Saat dikirim, laporan diteruskan ke penerima rekap di Telegram (bila bot aktif) dan stok akhir shift dicatat sebagai stock opname bahan baku divisi.</p>
                {flowOn && template && (
                  <div className="mb-3 rounded-lg bg-slate-50 p-3 text-sm">
                    <div className="mb-1 font-medium text-slate-700">Hasil kerja masuk stok saat dikirim{r.workPostedVersion > 0 ? " (posting lama dibatalkan dulu)" : ""}:</div>
                    {flow.length ? <ul className="space-y-0.5 text-slate-600">{flow.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-slate-500">Tidak ada (hasil kerja kosong)</p>}
                  </div>
                )}
                <Submit className="btn-success w-full sm:w-auto" pendingText="Mengirim…">Kirim laporan</Submit>
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
