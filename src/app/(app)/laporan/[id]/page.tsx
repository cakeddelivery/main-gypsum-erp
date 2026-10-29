import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime, fmtDay } from "@/lib/time";
import { STAGE_LABEL } from "@/lib/stock";
import { isTemplate, toEntries, type StockCountRow, type WorkData } from "@/lib/shiftReport";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { DownloadJpg } from "@/components/DownloadJpg";
import { sendReport } from "../actions";
import { ReportForm } from "./ReportForm";
import { ReportSheet } from "./ReportSheet";

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
  const saved = r.stockCount as StockCountRow[];
  // Saat diisi: daftar bahan mengikuti master bahan baku divisi terkini (hitungan yang sudah ada dipertahankan)
  const items = await prisma.item.findMany({ where: { divisionId: r.divisionId, active: true, type: "BAHAN_BAKU" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const editStock: StockCountRow[] = items.map((i) => ({ itemId: i.id, name: i.name, unit: i.unit, limit: Number(i.minStock), qty: saved.find((x) => x.itemId === i.id)?.qty ?? null }));
  const stock = saved;
  const work = r.work as WorkData;
  const canEdit = user.can("report.create") && !(ownOnly && user.divisionId !== r.divisionId);
  const day = r.date.toISOString().slice(0, 10);
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
          <div className="lg:order-1 lg:col-span-3">
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
            />
          </div>
        )}
        <div className={`space-y-5 ${canEdit ? "lg:order-2 lg:col-span-2" : "lg:col-span-3"}`}>
          <ReportSheet
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
            legacyLines={entries.map((e) => `${STAGE_LABEL[e.stage]}: ${e._sum.qtyGood ?? 0} pcs (reject ${e._sum.qtyReject ?? 0})`)}
          />
          <div className="flex items-center gap-2"><Badge tone={r.status === "TERKIRIM" ? "green" : r.status === "DIREVISI" ? "purple" : "amber"}>{r.status}</Badge><span className="text-xs text-slate-500">Dibuat oleh {r.createdBy}</span></div>
          {canEdit && (
            <Card title="Kirim laporan">
              <ActionForm action={sendReport} confirm="Kirim laporan sekarang? Stok akhir shift akan menjadi stok sistem (stock opname).">
                <input type="hidden" name="id" value={r.id} />
                <p className="mb-3 text-sm text-slate-500">Simpan dulu isian laporan. Saat dikirim, laporan diteruskan ke penerima rekap di Telegram (bila bot aktif) dan stok akhir shift dicatat sebagai stock opname bahan baku divisi.</p>
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
