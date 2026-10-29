import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { addPieceWork, claimPieces, deletePieceWork, savePieceTask } from "../actions";
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
  const emp = await prisma.employee.findMany({ where: { id: { in: unclaimed.map((u) => u.employeeId) } } });
  const t = todayStr();
  const activeTasks = tasks.filter((x) => x.active);
  return (
    <div className="space-y-5">
      <PageHeader title="Borongan & klaim" subtitle="Pekerja borongan dibayar per piece; gajian kapan saja sesuai klaim pekerja" actions={
        <Modal trigger="+ Hasil borongan" title="Catat hasil borongan">
          {workers.length === 0 ? <p className="text-sm text-slate-500">Belum ada karyawan dengan sistem upah Borongan. Ubah di menu Karyawan.</p> : (
            <ModalForm action={addPieceWork} className="grid grid-cols-2 gap-3">
              <Field label="Pekerja" className="col-span-2"><select name="employeeId" className="input">{workers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
              <Field label="Tugas"><select name="taskId" className="input">{activeTasks.map((x) => <option key={x.id} value={x.id}>{x.name} ({idr(x.ratePerPcs)}/pcs)</option>)}</select></Field>
              <Field label="Jumlah (pcs)"><input name="qty" inputMode="numeric" className="input" required /></Field>
              <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
              <Field label="Catatan"><input name="note" className="input" /></Field>
              <div className="col-span-2"><Submit>Simpan</Submit></div>
            </ModalForm>
          )}
        </Modal>
      } />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Tarif tugas borongan" actions={
          <Modal trigger="+ Tugas" triggerClass="btn-primary btn-sm" title="Tugas borongan baru">
            <ModalForm action={savePieceTask} className="space-y-3">
              <Field label="Nama tugas"><input name="name" className="input" required /></Field>
              <Field label="Tarif/pcs (IDR)"><input name="ratePerPcs" inputMode="numeric" className="input" required /></Field>
              <Submit>Tambah</Submit>
            </ModalForm>
          </Modal>
        }>
          <ul className="divide-y divide-slate-100 text-sm">
            {tasks.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-1.5">
                <span>{x.name}{!x.active && <Badge>nonaktif</Badge>}</span>
                <span className="flex items-center gap-2"><span className="tabular-nums">{idr(x.ratePerPcs)}/pcs</span>
                  <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${x.name}`}>
                    <ModalForm action={savePieceTask} className="space-y-3">
                      <input type="hidden" name="id" value={x.id} />
                      <Field label="Nama"><input name="name" defaultValue={x.name} className="input" /></Field>
                      <Field label="Tarif/pcs (IDR)" hint="Tarif baru berlaku untuk input berikutnya"><input name="ratePerPcs" defaultValue={Number(x.ratePerPcs)} inputMode="numeric" className="input" /></Field>
                      <Field label="Status"><select name="active" defaultValue={x.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>
                      <Submit>Simpan</Submit>
                    </ModalForm>
                  </Modal>
                </span>
              </li>
            ))}
          </ul>
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
                      <td>
                        <Modal trigger="Klaim" triggerClass="btn-primary btn-sm" title={`Klaim borongan ${e.name}`}>
                          <ModalForm action={claimPieces} className="space-y-3">
                            <input type="hidden" name="employeeId" value={e.id} />
                            <Field label="Klaim hasil sampai tanggal"><input type="date" name="upTo" defaultValue={t} className="input" /></Field>
                            <p className="text-sm text-slate-500">Slip klaim dibuat sebagai draft, lalu disetujui & dibayar dari halaman penggajian.</p>
                            <Submit>Buat klaim</Submit>
                          </ModalForm>
                        </Modal>
                      </td>
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
