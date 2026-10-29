import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { Badge, Card, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { BackLink } from "../shared";
import { createLoan, createPayable, createReceivable, settle } from "../actions";

export const metadata = { title: "Piutang, Utang & Pinjaman" };

export default async function PiutangUtang({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePerm("accounting.view");
  const { tab = "piutang" } = await searchParams;
  const [recv, pay, stores, banks, revenueAcc, debitAcc, suppliers] = await Promise.all([
    prisma.receivable.findMany({ orderBy: { date: "desc" } }),
    prisma.payable.findMany({ orderBy: { date: "desc" } }),
    prisma.store.findMany(),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.coaAccount.findMany({ where: { type: "PENDAPATAN", active: true }, orderBy: { code: "asc" } }),
    prisma.coaAccount.findMany({ where: { type: { in: ["BEBAN", "ASET", "HPP"] }, active: true, isCash: false }, orderBy: { code: "asc" } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
  ]);
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name;
  const common = (
    <>
      <Field label="Toko"><select name="storeId" className="input">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
      <Field label="Jatuh tempo"><input type="date" name="dueDate" className="input" /></Field>
      <Field label="Nominal (IDR)"><input name="amount" inputMode="numeric" className="input" required /></Field>
      <Field label="Catatan" className="col-span-2"><input name="note" className="input" /></Field>
    </>
  );
  const usaha = pay.filter((p) => p.kind === "USAHA");
  const loans = pay.filter((p) => p.kind === "PINJAMAN");
  const rows = tab === "piutang" ? recv.map((r) => ({ ...r, party: r.customer })) : (tab === "pinjaman" ? loans : usaha).map((p) => ({ ...p, party: p.vendor }));
  return (
    <div className="space-y-4">
      <PageHeader title="Piutang, utang & pinjaman" actions={<><BackLink />{user.can("accounting.post") && (tab === "piutang" ? (
        <Modal trigger="+ Piutang" title="Piutang baru">
          <ModalForm action={createReceivable} className="grid grid-cols-2 gap-3">
            <Field label="Pelanggan" className="col-span-2"><input name="customer" className="input" required /></Field>
            <Field label="Akun pendapatan" className="col-span-2"><select name="revenueAccountId" className="input">{revenueAcc.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
            {common}<div className="col-span-2"><Submit>Simpan</Submit></div>
          </ModalForm>
        </Modal>
      ) : tab === "pinjaman" ? (
        <Modal trigger="+ Pinjaman modal" title="Pinjaman modal baru">
          <ModalForm action={createLoan} className="grid grid-cols-2 gap-3">
            <Field label="Pemberi pinjaman" className="col-span-2"><input name="vendor" className="input" required /></Field>
            <Field label="Uang masuk ke rekening" className="col-span-2"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            {common}<div className="col-span-2"><Submit>Simpan</Submit></div>
          </ModalForm>
        </Modal>
      ) : (
        <Modal trigger="+ Utang" title="Utang baru">
          <ModalForm action={createPayable} className="grid grid-cols-2 gap-3">
            <Field label="Supplier"><select name="supplierId" className="input"><option value="">— lainnya —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Nama pemasok (bila lainnya)"><input name="vendor" className="input" /></Field>
            <Field label="Akun debit (beban/persediaan/aset)" className="col-span-2"><select name="debitAccountId" className="input">{debitAcc.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
            {common}<div className="col-span-2"><Submit>Simpan</Submit></div>
          </ModalForm>
        </Modal>
      ))}</>} />
      <Tabs current={tab} tabs={[{ key: "piutang", label: "Piutang", href: "?tab=piutang", count: recv.filter((r) => r.paid < r.amount).length }, { key: "utang", label: "Utang supplier", href: "?tab=utang", count: usaha.filter((r) => r.paid < r.amount).length }, { key: "pinjaman", label: "Pinjaman modal", href: "?tab=pinjaman", count: loans.filter((r) => r.paid < r.amount).length }]} />
      <Card>
        <div className="mb-3 text-sm">Total outstanding: <b>{idr(rows.reduce((s, r) => s + Number(r.amount - r.paid), 0))}</b></div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>No.</th><th>{tab === "piutang" ? "Pelanggan" : tab === "pinjaman" ? "Pemberi pinjaman" : "Pemasok"}</th><th>Toko</th><th>Tanggal</th><th>Jatuh tempo</th><th className="num">Nominal</th><th className="num">Dibayar</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const rem = Number(r.amount - r.paid);
                const overdue = rem > 0 && r.dueDate && r.dueDate < new Date();
                return (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.number}</td><td>{r.party}</td><td>{storeName(r.storeId)}</td><td>{fmtDate(r.date)}</td><td>{fmtDate(r.dueDate)}</td><td className="num">{idr(r.amount)}</td><td className="num">{idr(r.paid)}</td>
                    <td>{rem === 0 ? <Badge tone="green">Lunas</Badge> : overdue ? <Badge tone="red">Jatuh tempo</Badge> : <Badge tone="amber">Belum lunas</Badge>}</td>
                    <td>{rem > 0 && user.can("accounting.post") && (
                      <Modal trigger={tab === "piutang" ? "Terima" : "Bayar"} triggerClass="btn-secondary btn-sm" title={`${tab === "piutang" ? "Pelunasan" : "Pembayaran"} ${r.number}`}>
                        <ModalForm action={settle} className="space-y-3">
                          <input type="hidden" name="kind" value={tab === "piutang" ? "piutang" : "utang"} /><input type="hidden" name="id" value={r.id} />
                          <Field label="Rekening"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                          <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
                          <Field label={`Nominal pokok (sisa ${idr(rem)})`}><input name="amount" defaultValue={rem} inputMode="numeric" className="input" /></Field>
                          {tab !== "piutang" && <Field label="Bunga / biaya (opsional)" hint="Dicatat sebagai beban, tidak mengurangi pokok"><input name="interest" defaultValue={0} inputMode="numeric" className="input" /></Field>}
                          <Submit>Bukukan</Submit>
                        </ModalForm>
                      </Modal>
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
