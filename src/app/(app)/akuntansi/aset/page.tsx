import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { monthlyDepreciation } from "@/lib/accounting";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { Empty, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { createAsset } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Aset Tetap" };

export default async function AsetPage() {
  const user = await requirePerm("accounting.view");
  const [assets, stores, banks, assetAcc, dep] = await Promise.all([
    prisma.fixedAsset.findMany({ orderBy: { acquiredAt: "desc" } }),
    prisma.store.findMany(),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.coaAccount.findMany({ where: { code: { startsWith: "1-2" }, NOT: { code: "1-2900" } }, orderBy: { code: "asc" } }),
    prisma.journal.findMany({ where: { source: "PENYUSUTAN" }, include: { lines: true } }),
  ]);
  const accum = (id: string) => dep.filter((j) => j.sourceId?.startsWith(`${id}:`)).reduce((s, j) => s + j.lines.reduce((x, l) => x + Number(l.debit), 0), 0);
  return (
    <div>
      <PageHeader title="Aset tetap" subtitle="Penyusutan garis lurus dibukukan otomatis saat tutup buku bulanan" actions={<>{user.can("accounting.post") && (
        <Modal trigger="+ Aset" title="Aset baru">
          <ModalForm action={createAsset} className="grid grid-cols-2 gap-3">
            <Field label="Nama aset" className="col-span-2"><input name="name" className="input" required /></Field>
            <Field label="Akun aset"><select name="assetAccountId" className="input">{assetAcc.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
            <Field label="Toko"><select name="storeId" className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Tanggal perolehan"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
            <Field label="Harga perolehan (IDR)"><input name="cost" inputMode="numeric" className="input" required /></Field>
            <Field label="Umur manfaat (bulan)"><input name="usefulLifeMonths" inputMode="numeric" defaultValue="48" className="input" /></Field>
            <Field label="Nilai sisa (IDR)"><input name="residual" inputMode="numeric" defaultValue="0" className="input" /></Field>
            <Field label="Sumber dana" className="col-span-2"><select name="funding" className="input">{banks.map((b) => <option key={b.id} value={b.id}>Dibayar dari {b.name}</option>)}<option value="UTANG">Utang usaha</option><option value="SALDO_AWAL">Saldo awal (aset lama)</option></select></Field>
            <div className="col-span-2"><Submit>Simpan</Submit></div>
          </ModalForm>
        </Modal>
      )}</>} />
      {assets.length === 0 ? <Empty title="Belum ada aset tetap" /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Nama</th><th>Perolehan</th><th className="num">Harga</th><th className="num">Umur</th><th className="num">Penyusutan/bln</th><th className="num">Akumulasi</th><th className="num">Nilai buku</th></tr></thead>
            <tbody>{assets.map((a) => { const acc = accum(a.id); return <tr key={a.id}><td>{a.name}</td><td>{fmtDate(a.acquiredAt)}</td><td className="num">{idr(a.cost)}</td><td className="num">{a.usefulLifeMonths} bln</td><td className="num">{idr(monthlyDepreciation(Number(a.cost), Number(a.residual), a.usefulLifeMonths))}</td><td className="num">{idr(acc)}</td><td className="num font-semibold">{idr(Number(a.cost) - acc)}</td></tr>; })}</tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
