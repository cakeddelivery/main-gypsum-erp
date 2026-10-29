import { Fragment } from "react";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { letterhead } from "@/lib/letterhead";
import { DocBar, DocSection, DocSheet, DocSummary, DocTable, fmtLong, fmtRange } from "@/components/DocSheet";
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
  const earn: { l: string; v: number }[] = [];
  if (s.period.kind === "BULANAN") earn.push({ l: "Gaji pokok bulanan", v: Number(s.baseSalary) });
  else if (s.period.kind === "PERIODE") earn.push({ l: `Upah harian (${s.daysPresent} × ${idr(s.employee.dailyRate)})`, v: Number(s.dailyWage) });
  for (const a of s.allowanceDetail as { name: string; amount: number }[]) earn.push({ l: a.name, v: a.amount });
  for (const d of detail) earn.push({ l: `Borongan ${stageLabel(d.stage)} (${d.qty.toLocaleString("id-ID")} × ${idr(d.rate)})`, v: d.amount });
  if (Number(s.transport) > 0) earn.push({ l: "Transport assembling", v: Number(s.transport) });
  if (Number(s.bonus) > 0) earn.push({ l: "Bonus", v: Number(s.bonus) });
  const cut: { l: string; v: number }[] = [];
  if (Number(s.deduction) > 0) cut.push({ l: s.absentDays ? `Potongan bolos ${s.absentDays} hari / terlambat` : "Potongan", v: Number(s.deduction) });
  for (const a of s.advanceDetail as { number: string; amount: number }[]) cut.push({ l: `Potongan kasbon ${a.number}`, v: a.amount });
  const sum = (x: { v: number }[]) => x.reduce((t, r) => t + r.v, 0);
  const tunj = s.period.kind === "TUNJANGAN";
  const lh = await letterhead();
  const info: [string, React.ReactNode][] = [
    ["Nama", s.employee.name], ["Kode", s.employee.code], ["Divisi", s.employee.division.name],
    ...(!tunj ? [["Hari hadir", `${s.daysPresent} hari`] as [string, string]] : []),
    ...(s.period.kind === "BULANAN" ? [["Libur (jatah)", `${s.offDays} hari`], ["Bolos", `${s.absentDays} hari`]] as [string, string][] : []),
    ...(s.period.payDate ? [[tunj ? "Tanggal bayar" : "Tanggal gajian", fmtLong(s.period.payDate)] as [string, string]] : []),
    ["Status", `${s.period.status}${s.period.paidAt ? ` · dibayar ${fmtDay(s.period.paidAt)}` : ""}`],
  ];
  return (
    <div>
      <PageHeader title="Slip gaji" subtitle={`${s.employee.name} · ${s.period.code}`} actions={<><DownloadJpg targetId="slip" filename={`slip-${s.employee.code}-${s.period.code}`} /></>} />
      <DocSheet
        id="slip" lh={lh} exportWidth={900} eyebrow={tunj ? "Slip tunjangan karyawan" : "Slip gaji karyawan"} title={tunj ? "Slip Tunjangan" : "Slip Gaji"}
        subtitle={`${s.employee.name} · ${s.employee.division.name}`}
        meta={{ label: `Periode ${s.period.code}`, value: fmtRange(s.period.startDate.toISOString(), s.period.endDate.toISOString()) }}
        signer="Finance" signDate={s.period.paidAt ? todayStr(s.period.paidAt) : undefined}
        notes={[
          ...(s.note ? [s.note] : []),
          ...(advanceLeft > 0 ? [`Sisa kasbon setelah gaji ini: ${idr(advanceLeft)}.`] : []),
          "Slip ini dihasilkan secara otomatis dari sistem dan sah tanpa tanda tangan basah.",
        ]}
      >
        <DocSection title="Data karyawan">
          <dl className="doc-kv">{info.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        </DocSection>
        <DocSection no={1} tone="green" title="Pendapatan">
          <DocTable head={<tr><th>Keterangan</th><th className="num">Jumlah (Rp)</th></tr>} empty={earn.length ? undefined : "Tidak ada pendapatan"}>
            {earn.map((r, i) => <tr key={i}><td>{r.l}</td><td className="num">{r.v.toLocaleString("id-ID")}</td></tr>)}
          </DocTable>
          <DocBar label="Total pendapatan" value={idr(sum(earn))} tone="green" />
        </DocSection>
        {cut.length > 0 && (
          <DocSection no={2} tone="red" title="Potongan">
            <DocTable head={<tr><th>Keterangan</th><th className="num">Jumlah (Rp)</th></tr>}>
              {cut.map((r, i) => <tr key={i}><td>{r.l}</td><td className="num doc-neg">-{r.v.toLocaleString("id-ID")}</td></tr>)}
            </DocTable>
            <DocBar label="Total potongan" value={`-${idr(sum(cut))}`} tone="red" negative />
          </DocSection>
        )}
        <DocSummary rows={[{ label: "Total diterima", hint: s.period.payDate ? `${tunj ? "Dibayar" : "Gajian"} ${fmtLong(s.period.payDate)}` : undefined, value: idr(s.total), strong: true }]} />
      </DocSheet>
    </div>
  );
}
