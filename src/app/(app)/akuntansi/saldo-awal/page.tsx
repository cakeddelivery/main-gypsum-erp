import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/time";
import { Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { JournalLines } from "../JournalLines";
import { openingBalance } from "../actions";

export const metadata = { title: "Saldo Awal" };

export default async function SaldoAwal() {
  await requirePerm("accounting.post");
  const accounts = await prisma.coaAccount.findMany({ where: { active: true, type: { in: ["ASET", "KEWAJIBAN", "EKUITAS"] } }, orderBy: { code: "asc" } });
  return (
    <div className="space-y-5">
      <PageHeader title="Saldo awal & penyesuaian" subtitle="Masukkan saldo pembukaan rekening, piutang, utang, persediaan, dan modal" actions={
        <Modal trigger="+ Saldo awal" title="Input saldo awal" wide>
        <ModalForm action={openingBalance} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tanggal saldo"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
          </div>
          <JournalLines accounts={accounts} mode="opening" />
          <p className="text-xs text-slate-500">Isi nominal sesuai saldo normal akun (aset = debit, kewajiban/ekuitas = kredit). Selisih otomatis diseimbangkan ke akun 3-9000 Ekuitas Saldo Awal. Untuk penyesuaian lain gunakan Jurnal umum → jenis Penyesuaian.</p>
          <Submit>Bukukan saldo awal</Submit>
        </ModalForm>
        </Modal>
      } />
      <Card title="Cara mengisi">
        <p className="text-sm text-slate-600">Tekan <b>+ Saldo awal</b> lalu isi saldo pembukaan per akun. Saldo yang sudah dibukukan tampil di <a className="link" href="/akuntansi/jurnal">Jurnal umum</a> dan <a className="link" href="/akuntansi/neraca">Neraca</a>.</p>
      </Card>
    </div>
  );
}
