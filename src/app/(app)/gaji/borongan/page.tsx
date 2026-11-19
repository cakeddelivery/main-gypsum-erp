import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { deletePieceWork } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Borongan & Klaim" };

export default async function BoronganPage() {
  await requirePerm("payroll.manage");
  const [tasks, workers, unclaimed, recent, claims] = await Promise.all([
    prisma.pieceTask.findMany({ orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { status: { not: "NONAKTIF" }, wageType: { in: ["BORONGAN", "CAMPURAN"] } }, orderBy: { name: "asc" } }),
    prisma.pieceWork.groupBy({ by: ["employeeId"], where: { periodId: null }, _sum: { amount: true, qty: true }, _min: { date: true } }),
    prisma.pieceWork.findMany({ include: { employee: true, task: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 50 }),
    prisma.payrollPeriod.findMany({ where: { kind: "BORONGAN" }, include: { payslips: { include: { employee: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const openClaims = claims.filter((c) => c.status !== "DIBAYAR").length;
  const emp = await prisma.employee.findMany({ where: { id: { in: unclaimed.map((u) => u.employeeId) } } });
  const t = todayStr();
  const activeTasks = tasks.filter((x) => x.active);
  return (
    <div className="space-y-5">
      <PageHeader title="Borongan & klaim (alur lama, read-only)" subtitle="Hanya untuk melihat riwayat dan menyelesaikan klaim yang sudah ada" actions={<Link href="/borongan?tab=klaim" className="btn-primary">Buka Borongan › Klaim Upah</Link>} />
      <div role="note" className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <b>Gunakan Borongan › Klaim Upah.</b> Halaman ini tidak lagi menerima hasil atau klaim baru (alur lama per karyawan).
        <div className="text-xs">Masih terbuka: <b>{unclaimed.length}</b> pekerja dengan hasil belum diklaim (Rp {Number(unclaimed.reduce((a, u) => a + Number(u._sum.amount ?? 0), 0)).toLocaleString("id-ID")}) · <b>{openClaims}</b> klaim belum dibayar · <b>{workers.length}</b> karyawan bersistem upah Borongan/Campuran.</div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Tarif tugas borongan" actions={<Link href="/borongan?tab=tugas" className="btn-secondary btn-sm">Atur Di Menu Borongan</Link>}>
          <ul className="divide-y divide-slate-100 text-sm">
            {tasks.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-1.5">
                <span>{x.name}{!x.active && <Badge>nonaktif</Badge>}</span>
                <span className="tabular-nums">{idr(x.ratePerPcs)}/pcs</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">Borongan tetangga (pekerja, koordinator, driver) dicatat di menu Borongan. Halaman ini untuk karyawan bersistem upah borongan.</p>
        </Card>
      </div>

      <Card title="Belum diklaim">
        {unclaimed.length === 0 ? <p className="text-sm text-slate-500">Semua hasil borongan sudah diklaim.</p> : (
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>Pekerja</th><th>Sejak</th><th className="num">Total pcs</th><th className="num">Nilai</th><th /></tr></thead>
              <tbody>
                {unclaimed.map((u) => {
                  const e = emp.find((x) => x.id === u.employeeId)!;
                  return (
                    <tr key={u.employeeId}>
                      <td>{e.name}</td><td>{fmtDay(u._min.date)}</td><td className="num">{(u._sum.qty ?? 0).toLocaleString("id-ID")}</td><td className="num font-semibold">{idr(u._sum.amount ?? 0)}</td>
                      <td className="text-xs text-slate-400">klaim via Borongan</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></Paged>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Klaim terakhir">
          {claims.length === 0 ? <Empty title="Belum ada klaim" /> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {claims.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-1.5">
                  <Link href={`/gaji/${c.id}`} className="hover:underline">{c.payslips[0]?.employee.name ?? c.code} · {fmtDay(c.endDate)}</Link>
                  <span className="flex items-center gap-2"><span className="tabular-nums">{idr(c.payslips[0]?.total ?? 0)}</span><Badge tone={c.status === "DIBAYAR" ? "green" : c.status === "DISETUJUI" ? "blue" : "amber"}>{c.status}</Badge></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Input terakhir">
          <ul className="divide-y divide-slate-100 text-sm">
            {recent.map((w) => (
              <li key={w.id} className="flex items-center justify-between py-1.5">
                <span>{fmtDay(w.date)} · {w.employee.name} · {w.task.name} × {w.qty.toLocaleString("id-ID")}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{idr(w.amount)}</span>
                  {w.periodId ? <Badge tone="blue">diklaim</Badge> : (
                    <ActionForm action={deletePieceWork} confirm="Hapus input ini?"><input type="hidden" name="id" value={w.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
