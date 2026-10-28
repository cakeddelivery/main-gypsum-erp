import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { Badge, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Slip Gaji Saya" };

export default async function SlipSaya() {
  const user = await requirePerm("payroll.self");
  if (!user.employeeId) return <Empty title="Akun belum ditautkan ke data karyawan" />;
  const slips = await prisma.payslip.findMany({ where: { employeeId: user.employeeId, period: { status: { in: ["DISETUJUI", "DIBAYAR"] } } }, include: { period: true }, orderBy: { period: { startDate: "desc" } } });
  const paid = slips.filter((s) => s.period.status === "DIBAYAR").reduce((a, s) => a + Number(s.total), 0);
  return (
    <div>
      <PageHeader title="Slip gaji saya" subtitle={`Total diterima (riwayat): ${idr(paid)}`} />
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
