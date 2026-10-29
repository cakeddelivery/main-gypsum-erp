import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { STAGE_LABEL } from "@/lib/stock";
import { PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import type { ProductionStage } from "@prisma/client";

export const metadata = { title: "Slip Gaji" };

export default async function SlipPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("payroll.view", "payroll.self");
  const { id } = await params;
  const s = await prisma.payslip.findUnique({ where: { id }, include: { period: true, employee: { include: { division: true } } } });
  if (!s) notFound();
  // Karyawan hanya boleh melihat slip miliknya sendiri
  if (!user.can("payroll.view") && s.employeeId !== user.employeeId) notFound();
  const detail = s.pieceDetail as { stage: string; qty: number; rate: number; amount: number }[];
  const advances = await prisma.cashAdvance.findMany({ where: { employeeId: s.employeeId } });
  const advanceLeft = Math.max(0, advances.reduce((a, x) => a + Number(x.amount - x.repaid), 0) - (s.period.status === "DIBAYAR" ? 0 : Number(s.advanceDeduction)));
  const stageLabel = (x: string) => STAGE_LABEL[x as ProductionStage] ?? x;
  const Row = ({ l, v, neg }: { l: string; v: number | bigint; neg?: boolean }) => (
    <div className="flex justify-between py-1"><span>{l}</span><span className={`tabular-nums ${neg ? "text-rose-600" : ""}`}>{neg ? "−" : ""}{idr(v)}</span></div>
  );
  return (
    <div>
      <PageHeader title="Slip gaji" subtitle={`${s.employee.name} · ${s.period.code}`} actions={<><DownloadJpg targetId="slip" filename={`slip-${s.employee.code}-${s.period.code}`} /></>} />
      <div id="slip" className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-sm">
        <div className="border-b pb-3 text-center">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-600">Main Gypsum</div>
          <div className="text-lg font-semibold">Slip Gaji</div>
          <div className="text-slate-500">{fmtDay(s.period.startDate)} – {fmtDay(s.period.endDate)}</div>
        </div>
        <div className="grid grid-cols-2 gap-y-1 border-b py-3">
          <span className="text-slate-500">Nama</span><span>{s.employee.name}</span>
          <span className="text-slate-500">Kode</span><span>{s.employee.code}</span>
          <span className="text-slate-500">Divisi</span><span>{s.employee.division.name}</span>
          <span className="text-slate-500">Hari hadir</span><span>{s.daysPresent} hari</span>
          {s.period.kind === "BULANAN" && <><span className="text-slate-500">Libur (jatah)</span><span>{s.offDays} hari</span><span className="text-slate-500">Bolos</span><span>{s.absentDays} hari</span></>}
          {s.period.payDate && <><span className="text-slate-500">Tanggal gajian</span><span>{fmtDay(s.period.payDate)}</span></>}
        </div>
        <div className="border-b py-3">
          {s.period.kind === "BULANAN" ? <Row l="Gaji pokok bulanan" v={s.baseSalary} /> : s.period.kind === "PERIODE" && <Row l={`Upah harian (${s.daysPresent} × ${idr(s.employee.dailyRate)})`} v={s.dailyWage} />}
          {detail.map((d) => <Row key={`${d.stage}${d.rate}`} l={`Borongan ${stageLabel(d.stage)} (${d.qty.toLocaleString("id-ID")} × ${idr(d.rate)})`} v={d.amount} />)}
          {Number(s.transport) > 0 && <Row l="Transport assembling" v={s.transport} />}
          {Number(s.bonus) > 0 && <Row l="Bonus" v={s.bonus} />}
          {Number(s.deduction) > 0 && <Row l={s.absentDays ? `Potongan bolos ${s.absentDays} hari / terlambat` : "Potongan"} v={s.deduction} neg />}
          {(s.advanceDetail as { number: string; amount: number }[]).map((a) => <Row key={a.number} l={`Potongan kasbon ${a.number}`} v={a.amount} neg />)}
        </div>
        <div className="flex justify-between pt-3 text-base font-semibold"><span>Total diterima</span><span>{idr(s.total)}</span></div>
        {s.note && <div className="mt-1 text-xs text-slate-500">{s.note}</div>}
        {advanceLeft > 0 && <div className="mt-1 text-xs text-slate-500">Sisa kasbon setelah gaji ini: {idr(advanceLeft)}</div>}
        <div className="mt-2 text-right text-xs text-slate-400">Status: {s.period.status}{s.period.paidAt && ` · dibayar ${fmtDay(s.period.paidAt)}`}</div>
      </div>
    </div>
  );
}
