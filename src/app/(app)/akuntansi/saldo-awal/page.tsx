import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/time";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { BackLink } from "../shared";
import { JournalLines } from "../JournalLines";
import { openingBalance } from "../actions";

export const metadata = { title: "Saldo Awal" };

export default async function SaldoAwal() {
  await requirePerm("accounting.post");
  const [accounts, stores] = await Promise.all([prisma.coaAccount.findMany({ where: { active: true, type: { in: ["ASET", "KEWAJIBAN", "EKUITAS"] } }, orderBy: { code: "asc" } }), prisma.store.findMany()]);
  return (
    <div className="space-y-5">
      <PageHeader title="Saldo awal & penyesuaian" subtitle="Masukkan saldo pembukaan rekening, piutang, utang, persediaan, dan modal" actions={<BackLink />} />
      <Card title="Input saldo awal">
        <ActionForm action={openingBalance} className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:w-1/2">
            <Field label="Tanggal saldo"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
            <Field label="Toko"><select name="storeId" className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          </div>
          <JournalLines accounts={accounts} mode="opening" />
          <p className="text-xs text-slate-500">Isi nominal sesuai saldo normal akun (aset = debit, kewajiban/ekuitas = kredit). Selisih otomatis diseimbangkan ke akun 3-9000 Ekuitas Saldo Awal. Untuk penyesuaian lain gunakan Jurnal umum → jenis Penyesuaian.</p>
          <Submit>Bukukan saldo awal</Submit>
        </ActionForm>
      </Card>
    </div>
  );
}
