import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr, dateStr } from "@/lib/time";
import { runningCycle, projectSalary } from "@/lib/salaryProjection";
import { Simulasi } from "./Simulasi";
import { Badge, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Slip Gaji Saya" };

export default async function SlipSaya() {
  const user = await requirePerm("payroll.self");
  if (!user.employeeId) return <Empty title="Akun belum ditautkan ke data karyawan" />;
  const slips = await prisma.payslip.findMany({ where: { employeeId: user.employeeId, period: { status: { in: ["DISETUJUI", "DIBAYAR"] } } }, include: { period: true }, orderBy: { period: { startDate: "desc" } } });
  const proj = await projection(user.employeeId);
  const paid = slips.filter((s) => s.period.status === "DIBAYAR").reduce((a, s) => a + Number(s.total), 0);
  return (
    <div>
      <PageHeader title="Slip gaji saya" subtitle={`Total diterima (riwayat): ${idr(paid)}`} />
      {proj && <Proyeksi p={proj} />}
      {slips.length === 0 ? <Empty title="Belum ada slip gaji" hint="Slip muncul setelah penggajian disetujui." /> : (
        <ul className="space-y-2">
          {slips.map((s) => (
            <li key={s.id}>
              <Link href={`/gaji/slip/${s.id}`} className="card flex items-center justify-between p-4 hover:bg-slate-50">
                <div><div className="font-medium">{s.period.code}</div><div className="text-xs text-slate-500">{fmtDay(s.period.startDate)} – {fmtDay(s.period.endDate)}</div></div>
                <div className="text-right"><div className="font-semibold tabular-nums">{idr(s.total)}</div><Badge tone={s.period.status === "DIBAYAR" ? "green" : "blue"}>{s.period.status === "DIBAYAR" ? "Dibayar" : "Disetujui"}</Badge></div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function projection(employeeId: string) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, include: { allowances: { where: { active: true } } } });
  if (!emp) return null;
  // Hak sesuai kontrak terkunci terbaru (addendum lebih baru menggantikan); tanpa kontrak → data master
  const contract = await prisma.contract.findFirst({ where: { employeeId, status: "AKTIF" }, orderBy: [{ startDate: "desc" }, { seq: "desc" }] });
  const snap = contract?.snapshot as { pay: { baseSalary: number; allowances: { name: string; amount: number; payDay: number }[]; bpjs: { covered: boolean; since: string }; payOffsetDays: number } } | undefined;
  const baseSalary = snap?.pay.baseSalary ?? Number(emp.monthlySalary);
  if (!(baseSalary > 0) || !emp.joinDate) return null;
  const allowances = snap?.pay.allowances ?? emp.allowances.map((a) => ({ name: a.name, amount: Number(a.amount), payDay: a.payDay }));
  const today = todayStr();
  const cycle = runningCycle(dateStr(emp.joinDate), today, snap?.pay.payOffsetDays ?? 7);
  const alpa = await prisma.attendance.count({ where: { employeeId, status: "ALPA", date: { gte: new Date(`${cycle.start}T00:00:00Z`), lte: new Date(`${today}T00:00:00Z`) } } });
  const input = { baseSalary, allowanceTotal: allowances.reduce((a, x) => a + x.amount, 0), alpaSoFar: alpa };
  return { cycle, allowances, input, bpjs: snap?.pay.bpjs ?? (emp.bpjsTk ? { covered: true, since: "" } : { covered: false, since: "" }), contractNo: contract?.number ?? null, contractId: contract?.id ?? null, now: projectSalary(input) };
}

function Proyeksi({ p }: { p: NonNullable<Awaited<ReturnType<typeof projection>>> }) {
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2">
      <section className="card space-y-1.5 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Hak sesuai kontrak</h3>
        <div className="flex justify-between"><span>Gaji pokok</span><b className="tabular-nums">{idr(p.input.baseSalary)}</b></div>
        {p.allowances.map((a, i) => <div key={i} className="flex justify-between"><span>Tunjangan {a.name} (tgl {a.payDay})</span><b className="tabular-nums">{idr(a.amount)}</b></div>)}
        {p.bpjs.covered && <div className="flex justify-between"><span>BPJS TK (ditanggung perusahaan)</span><b>✓</b></div>}
        <div className="flex justify-between"><span>Gaji pokok dibayar</span><b>{fmtDay(p.cycle.payDate)} (H+7)</b></div>
        {p.contractId && <Link href={`/kontrak/${p.contractId}`} className="link text-sm">Lihat kontrak {p.contractNo}</Link>}
      </section>
      <section className="card space-y-2 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Periode berjalan · {fmtDay(p.cycle.start)} – {fmtDay(p.cycle.end)}</h3>
        <div className="flex justify-between text-sm"><span>Alpa sejauh ini</span><b>{p.now.alpaDays} hari</b></div>
        <div className="flex justify-between text-sm"><span>Potongan Alpa sejauh ini</span><b className="tabular-nums text-rose-700">{p.now.cut ? `− ${idr(p.now.cut)}` : idr(0)}</b></div>
        <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Simulasi bolos</h3>
        <Simulasi input={p.input} />
      </section>
    </div>
  );
}
