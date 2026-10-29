import { Fragment } from "react";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { letterhead } from "@/lib/letterhead";
import { DocExport, DocBar, DocSection, DocSheet, DocSummary, DocTable, fmtLong, fmtRange } from "@/components/DocSheet";
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
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-sm">
        <div className="border-b pb-3 text-center">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-600">Main Gypsum</div>
          <div className="text-lg font-semibold">{s.period.kind === "TUNJANGAN" ? "Slip Tunjangan" : "Slip Gaji"}</div>
          <div className="text-slate-500">{fmtDay(s.period.startDate)} – {fmtDay(s.period.endDate)}</div>
        </div>
        <div className="grid grid-cols-2 gap-y-1 border-b py-3">
          <span className="text-slate-500">Nama</span><span>{s.employee.name}</span>
          <span className="text-slate-500">Kode</span><span>{s.employee.code}</span>
          <span className="text-slate-500">Divisi</span><span>{s.employee.division.name}</span>
          {s.period.kind !== "TUNJANGAN" && <><span className="text-slate-500">Hari hadir</span><span>{s.daysPresent} hari</span></>}
          {s.period.kind === "BULANAN" && <><span className="text-slate-500">Libur (jatah)</span><span>{s.offDays} hari</span><span className="text-slate-500">Bolos</span><span>{s.absentDays} hari</span></>}
          {s.period.payDate && <><span className="text-slate-500">{s.period.kind === "TUNJANGAN" ? "Tanggal bayar" : "Tanggal gajian"}</span><span>{fmtDay(s.period.payDate)}</span></>}
        </div>
        <div className="border-b py-3">
          {s.period.kind === "BULANAN" ? <Row l="Gaji pokok bulanan" v={s.baseSalary} /> : s.period.kind === "PERIODE" && <Row l={`Upah harian (${s.daysPresent} × ${idr(s.employee.dailyRate)})`} v={s.dailyWage} />}
          {(s.allowanceDetail as { name: string; amount: number }[]).map((a) => <Row key={a.name} l={a.name} v={a.amount} />)}
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
      <DocExport>
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
      </DocExport>
    </div>
  );
}
