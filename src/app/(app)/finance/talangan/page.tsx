import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { talanganStart, talanganSummary } from "@/lib/talangan";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { repayTalanganAction, setTalanganStart } from "./actions";

export const metadata = { title: "Dana Talangan" };

export default async function TalanganPage({ searchParams }: { searchParams: Promise<{ kembali?: string }> }) {
  await requirePerm("finance.approve");
  const { kembali } = await searchParams;
  const [wallets, start, banks, repays] = await Promise.all([
    talanganSummary(),
    talanganStart(),
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.financeTransaction.findMany({ where: { bailoutRepay: true, deletedAt: null }, orderBy: { date: "desc" }, take: 20 }),
  ]);
  const total = wallets.reduce((t, w) => t + w.outstanding, 0);
  const bankName = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "-";
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dana talangan"
        subtitle="Seabank 0006 & ShopeePay hanya dompet simpanan dana sisihan. Uang yang dipakai dari sana untuk operasional wajib dikembalikan dari rekening operasional."
        actions={
          <Modal trigger="Mulai dihitung" triggerClass="btn-secondary" title="Talangan dihitung mulai">
            <ModalForm action={setTalanganStart} className="space-y-3">
              <Field label="Tanggal mulai" hint="Pemakaian sebelum tanggal ini tidak dihitung"><input type="date" name="start" defaultValue={start} className="input" /></Field>
              <Submit>Simpan</Submit>
            </ModalForm>
          </Modal>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Belum dikembalikan" value={idr(total)} tone={total > 0 ? "red" : "green"} />
        {wallets.map((w) => <Stat key={w.bank.id} label={w.bank.name} value={idr(w.outstanding)} hint={`talangan ${idr(w.total)} · kembali ${idr(w.repaid)}${w.managerOutstanding > 0 ? ` · pinjaman pengelola ${idr(w.managerOutstanding)}` : ""}`} tone={w.outstanding > 0 ? "amber" : "green"} />)}
      </div>
      {wallets.length === 0 && <Empty title="Belum ada dana sisihan dengan rekening simpanan" />}
      {wallets.map((w) => (
        <Card
          key={w.bank.id}
          title={`${w.bank.name} · belum dikembalikan ${idr(w.outstanding)}`}
          actions={w.outstanding > 0 && (
            <Modal trigger="Kembalikan" triggerClass="btn-primary btn-sm" title={`Kembalikan talangan ke ${w.bank.name}`} defaultOpen={kembali === w.bank.id || (kembali === "1" && wallets.filter((x) => x.outstanding > 0)[0]?.bank.id === w.bank.id)}>
              <ModalForm action={repayTalanganAction} className="space-y-3">
                <input type="hidden" name="walletId" value={w.bank.id} />
                <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  Transfer <b>{idr(w.outstanding - w.managerOutstanding || w.outstanding)}</b> dari {w.fromBank?.name ?? "rekening operasional"} ke {w.bank.name}, lalu lampirkan buktinya.
                  {w.managerOutstanding > 0 && <> Pinjaman pengelola ({idr(w.managerOutstanding)}) dikembalikan oleh pengelola sendiri: catat sebagai uang masuk ke {w.bank.name} dengan kategori <b>Pengembalian Pinjaman Pengelola</b>.</>}
                  <ul className="mt-1 list-disc pl-4 text-xs">{w.open.slice(0, 10).map((i) => <li key={i.journalId}>{fmtDate(i.date)} · {i.label} {i.ref} · {i.description.slice(0, 40)} · {idr(i.amount)}</li>)}{w.open.length > 10 && <li>… {w.open.length - 10} lainnya</li>}</ul>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Dari rekening"><select name="fromBankId" defaultValue={w.fromBank?.id ?? ""} className="input">{banks.filter((b) => b.id !== w.bank.id && !b.marketplace).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Tanggal transfer"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
                  <Field label="Nominal (sesuai total talangan)" className="col-span-2"><input name="amount" defaultValue={w.outstanding - w.managerOutstanding || w.outstanding} inputMode="numeric" className="input" required /></Field>
                </div>
                <Field label="Foto bukti transfer" hint="Nominal di bukti dicek otomatis harus sama dengan nominal di atas"><input type="file" name="proof" required accept="image/jpeg,image/png,image/webp,application/pdf" className="input py-1.5" /></Field>
                <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" name="skipCheck" value="1" /> Nominal di bukti sudah benar (lewati pengecekan otomatis)</label>
                <Submit pendingText="Membaca bukti & membukukan…">Simpan pengembalian</Submit>
              </ModalForm>
            </Modal>
          )}
        >
          {w.items.length === 0 ? <p className="text-sm text-slate-500">Tidak ada pemakaian untuk operasional sejak {fmtDate(new Date(`${start}T00:00:00Z`))}.</p> : (
            <div className="overflow-x-auto">
              <Paged><table className="tbl">
                <thead><tr><th>Tanggal</th><th>Sumber</th><th>Keterangan</th><th className="num">Nominal</th><th>Status</th></tr></thead>
                <tbody>
                  {[...w.items].reverse().map((i) => {
                    const o = w.open.find((x) => x.journalId === i.journalId);
                    return (
                      <tr key={i.journalId}>
                        <td className="whitespace-nowrap">{fmtDate(i.date)}</td>
                        <td>{i.label} {i.href ? <Link className="link font-mono text-xs" href={i.href}>{i.ref}</Link> : <span className="font-mono text-xs">{i.ref}</span>}</td>
                        <td className="max-w-md truncate text-sm">{i.description}</td>
                        <td className="num">{idr(i.amount)}</td>
                        <td>{!o ? <Badge tone="green">Sudah kembali</Badge> : o.amount < i.amount ? <Badge tone="amber">Sisa {idr(o.amount)}</Badge> : <Badge tone="red">Belum</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></Paged>
            </div>
          )}
        </Card>
      ))}
      {repays.length > 0 && (
        <Card title="Riwayat pengembalian">
          <ul className="divide-y divide-slate-100 text-sm">
            {repays.map((t) => (
              <li key={t.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>{fmtDate(t.date)} · <Link className="link font-mono text-xs" href={`/finance/${t.id}`}>{t.number}</Link> · {bankName(t.accountId)} → {bankName(t.toAccountId)} {t.status !== "DIBUKUKAN" && <Badge tone="amber">{t.status}</Badge>}{!t.proofPath && <Badge tone="red">tanpa bukti</Badge>}</span>
                <span className="tabular-nums">{idr(t.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-slate-500">Dihitung sebagai talangan: transaksi keluar/transfer, pembelian, gaji, kasbon, dan borongan yang dibayar dari rekening simpanan sejak {fmtDate(new Date(`${start}T00:00:00Z`))}. Tidak dihitung: pengambilan kompensasi owner & bayar pinjaman lewat Dana sisihan, cicilan pinjaman dari rekening simpanan, dan transaksi berkategori kompensasi/prive owner.</p>
    </div>
  );
}
