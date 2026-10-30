import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { bankBalancesAt } from "@/lib/finance";
import { idr } from "@/lib/money";
import { todayStr } from "@/lib/time";
import { Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { adjustBankBalances } from "../actions";

export const metadata = { title: "Atur Saldo Rekening" };

export default async function SaldoRekening({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await requirePerm("accounting.post");
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayStr();
  const banks = await bankBalancesAt(date);
  return (
    <div className="space-y-5">
      <PageHeader title="Atur saldo rekening" subtitle="Samakan saldo di aplikasi dengan saldo asli di bank / e-wallet. Selisihnya dibukukan otomatis sebagai penyesuaian saldo awal (tidak masuk laba rugi maupun arus kas)." />
      <Card>
        <form className="flex flex-wrap items-end gap-3" method="get">
          <Field label="Saldo per tanggal (akhir hari)"><input type="date" name="date" defaultValue={date} className="input" /></Field>
          <button className="btn-secondary">Tampilkan saldo buku</button>
        </form>
      </Card>
      <Card title={`Saldo per ${date}`} actions={
        <Modal trigger="Atur saldo" triggerClass="btn-primary btn-sm" title={`Atur saldo per ${date}`} wide>
        <ModalForm action={adjustBankBalances} className="space-y-4">
          <input type="hidden" name="date" value={date} />
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Rekening</th><th className="num">Saldo di aplikasi</th><th>Saldo asli</th></tr></thead>
              <tbody>
                {banks.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}{b.code === "SALDO_SHOPEE" && <div className="text-xs text-slate-400">Opsional: tidak terhubung otomatis ke Shopee, kosongkan bila tidak ingin diubah</div>}</td>
                    <td className="num">{idr(b.balance)}</td>
                    <td><input name={`actual_${b.id}`} inputMode="numeric" placeholder="kosongkan = tidak diubah" className="input" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Isi saldo asli hanya untuk rekening yang ingin disesuaikan. Bisa diulang kapan saja; yang dibukukan hanya selisihnya.</p>
          <Submit>Simpan saldo</Submit>
        </ModalForm>
        </Modal>
      }>
        <Paged><table className="tbl">
          <thead><tr><th>Rekening</th><th className="num">Saldo di aplikasi</th></tr></thead>
          <tbody>{banks.map((b) => <tr key={b.id}><td>{b.name}</td><td className="num">{idr(b.balance)}</td></tr>)}</tbody>
        </table></Paged>
      </Card>
    </div>
  );
}
