import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { saveCoa } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Chart of Accounts" };
const TYPES = ["ASET", "KEWAJIBAN", "EKUITAS", "PENDAPATAN", "HPP", "BEBAN"] as const;

export default async function CoaPage() {
  const user = await requirePerm("accounting.view");
  const accounts = await prisma.coaAccount.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { lines: true } } } });
  const form = (a?: (typeof accounts)[number]) => (
    <ModalForm action={saveCoa} className="grid grid-cols-2 gap-3">
      {a && <input type="hidden" name="id" value={a.id} />}
      <Field label="Kode"><input name="code" defaultValue={a?.code} className="input" placeholder="6-1234" required /></Field>
      <Field label="Tipe"><select name="type" defaultValue={a?.type} className="input">{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
      <Field label="Nama" className="col-span-2"><input name="name" defaultValue={a?.name} className="input" required /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isCash" defaultChecked={a?.isCash} /> Akun kas/bank</label>
      {a && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={a.active} /> Aktif</label>}
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div>
      <PageHeader title="Chart of Accounts" subtitle="Bagan akun manufaktur" actions={<>{user.can("accounting.post") && <Modal trigger="+ Akun" title="Akun baru">{form()}</Modal>}</>} />
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th>Kas/Bank</th><th className="num">Baris jurnal</th><th /></tr></thead>
          <tbody>{accounts.map((a) => <tr key={a.id} className={a.active ? "" : "opacity-50"}><td className="font-mono text-xs">{a.code}</td><td>{a.name}</td><td><Badge>{a.type}</Badge></td><td>{a.isCash ? "✓" : ""}</td><td className="num">{a._count.lines}</td><td>{user.can("accounting.post") && <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah akun">{form(a)}</Modal>}</td></tr>)}</tbody>
        </table></Paged>
      </div>
    </div>
  );
}
