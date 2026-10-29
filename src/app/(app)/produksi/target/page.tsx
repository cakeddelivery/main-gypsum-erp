import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { saveTarget } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Target Produksi" };

export default async function TargetPage() {
  const user = await requirePerm("production.target");
  const fixedDivision = user.role === "KAPTEN_DIVISI" ? user.divisionId : null;
  const [targets, divisions, employees] = await Promise.all([
    prisma.productionTarget.findMany({ where: fixedDivision ? { divisionId: fixedDivision } : {}, include: { division: true, employee: true }, orderBy: [{ divisionId: "asc" }, { stage: "asc" }] }),
    prisma.division.findMany({ where: { active: true, ...(fixedDivision ? { id: fixedDivision } : {}) } }),
    prisma.employee.findMany({ where: { status: "AKTIF", ...(fixedDivision ? { divisionId: fixedDivision } : {}) }, orderBy: { name: "asc" } }),
  ]);
  const form = (t?: (typeof targets)[number]) => (
    <ModalForm action={saveTarget} className="grid grid-cols-2 gap-3">
      {t && <input type="hidden" name="id" value={t.id} />}
      <label className="col-span-2"><span className="label">Divisi</span>
        <select name="divisionId" className="input" defaultValue={t?.divisionId}>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </label>
      <label className="col-span-2"><span className="label">Karyawan (kosongkan untuk target divisi)</span>
        <select name="employeeId" className="input" defaultValue={t?.employeeId ?? ""}><option value="">— Target divisi —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
      </label>
      <label><span className="label">Tahap</span>
        <select name="stage" className="input" defaultValue={t?.stage}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select>
      </label>
      <label><span className="label">Target / hari (pcs)</span><input name="dailyQty" inputMode="numeric" className="input" defaultValue={t?.dailyQty} required /></label>
      {t && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={t.active} /> Aktif</label>}
      <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div>
      <PageHeader title="Target produksi" subtitle="Target harian per divisi atau per karyawan" actions={<Modal trigger="+ Target" title="Target baru">{form()}</Modal>} />
      {targets.length === 0 ? <Empty /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Divisi</th><th>Karyawan</th><th>Tahap</th><th className="num">Target/hari</th><th>Status</th><th /></tr></thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id}>
                  <td>{t.division.name}</td><td>{t.employee?.name ?? <span className="text-slate-400">Divisi</span>}</td><td>{STAGE_LABEL[t.stage]}</td>
                  <td className="num">{t.dailyQty}</td><td>{t.active ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</td>
                  <td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah target">{form(t)}</Modal></td>
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
