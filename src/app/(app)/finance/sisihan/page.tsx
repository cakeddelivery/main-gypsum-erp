import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { RESERVE_LABEL, reserveSummary } from "@/lib/reserve";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { reserveAll, reserveOne, saveFund, withdraw } from "./actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Dana Sisihan Harian" };

export default async function SisihanPage() {
  await requirePerm("finance.approve");
  const [funds, banks, loans, recent] = await Promise.all([
    reserveSummary(),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.payable.findMany({ where: { kind: "PINJAMAN" }, orderBy: { date: "desc" } }),
    prisma.reserveEntry.findMany({ include: { fund: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 40 }),
  ]);
  const t = todayStr();
  const bankName = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "-";
  const active = funds.filter((f) => f.active);
  const daily = active.reduce((s, f) => s + Number(f.dailyAmount), 0);
  const pendingToday = active.filter((f) => !f.doneToday);
  const fundForm = (f?: (typeof funds)[number]) => (
    <ModalForm action={saveFund} className="grid grid-cols-2 gap-3">
      {f && <input type="hidden" name="id" value={f.id} />}
      <Field label="Nama dana" className="col-span-2"><input name="name" defaultValue={f?.name} className="input" required /></Field>
      <Field label="Jenis" className="col-span-2"><select name="kind" defaultValue={f?.kind ?? "OWNER"} className="input">{Object.entries(RESERVE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Nominal per hari (IDR)"><input name="dailyAmount" defaultValue={f ? Number(f.dailyAmount) : ""} inputMode="numeric" className="input" required /></Field>
      <Field label="Dari rekening"><select name="fromBankId" defaultValue={f?.fromBankId ?? banks.find((b) => b.code === "SEABANK")?.id} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="Ke rekening simpanan" hint="Tidak dipakai untuk cicilan harian"><select name="toBankId" defaultValue={f?.toBankId ?? banks.find((b) => b.code === "SHOPEEPAY")?.id} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="Pinjaman modal (untuk dana cicilan)" className="col-span-2" hint={loans.length ? "Wajib untuk Cicilan pinjaman harian. Tabungan cicilan boleh dikosongkan dulu, pilih sebelum dibayarkan." : "Belum ada pinjaman modal tercatat. Catat dulu di Akuntansi › Piutang, utang & pinjaman (tombol + Pinjaman modal). Tabungan cicilan tetap bisa disimpan tanpa pinjaman."}><select name="payableId" defaultValue={f?.payableId ?? ""} className="input" data-plain={loans.length ? undefined : ""}><option value="">{loans.length ? "— belum dipilih —" : "— belum ada pinjaman —"}</option>{loans.map((l) => <option key={l.id} value={l.id}>{l.number} · {l.vendor} · sisa {idr(l.amount - l.paid)}</option>)}</select></Field>
      {f && <Field label="Status"><select name="active" defaultValue={f.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dana sisihan harian"
        subtitle="Kompensasi pengelola (owner) yang dicadangkan di ShopeePay dan dana cicilan pinjaman modal"
        actions={
          <>
            <Modal trigger="+ Dana" triggerClass="btn-secondary" title="Dana sisihan baru">{fundForm()}</Modal>
            <Modal trigger="Sisihkan semua" title="Sisihkan semua dana aktif">
              <ModalForm action={reserveAll} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Dari tanggal"><input type="date" name="from" defaultValue={t} max={t} className="input" /></Field>
                  <Field label="Sampai tanggal"><input type="date" name="date" defaultValue={t} max={t} className="input" /></Field>
                </div>
                <p className="text-xs text-slate-500">Setiap dana aktif dicatat sekali per hari dengan nominal hariannya. Tanggal yang sudah disisihkan otomatis dilewati, jadi aman untuk mengejar hari yang terlewat.</p>
                <Submit pendingText="Mencatat…">Sisihkan</Submit>
              </ModalForm>
            </Modal>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total sisihan per hari" value={idr(daily)} />
        <Stat label="Hari ini" value={pendingToday.length ? `${pendingToday.length} belum` : "Sudah semua"} tone={pendingToday.length ? "amber" : "green"} />
        <Stat label="Kompensasi owner tersimpan" value={idr(funds.filter((f) => f.kind === "OWNER").reduce((s, f) => s + f.balance, 0))} hint="Belum diambil owner" />
        <Stat label="Tabungan cicilan" value={idr(funds.filter((f) => f.kind === "LOAN_SAVING").reduce((s, f) => s + f.balance, 0))} />
      </div>
      {funds.length === 0 ? <Empty title="Belum ada dana sisihan" /> : (
        <Card title="Dana">
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>Dana</th><th>Alur</th><th className="num">Per hari</th><th className="num">Bulan ini</th><th className="num">Saldo</th><th>Hari ini</th><th /></tr></thead>
              <tbody>
                {funds.map((f) => (
                  <tr key={f.id} className={f.active ? "" : "opacity-50"}>
                    <td>{f.name}<div className="text-xs text-slate-400">{RESERVE_LABEL[f.kind]}</div></td>
                    <td className="text-xs">{bankName(f.fromBankId)} → {f.kind === "LOAN_PAYMENT" ? "cicilan pinjaman" : bankName(f.toBankId)}</td>
                    <td className="num">{idr(f.dailyAmount)}</td><td className="num">{idr(f.month)}</td><td className="num font-semibold">{f.kind === "LOAN_PAYMENT" ? "-" : idr(f.balance)}</td>
                    <td>{f.doneToday ? <Badge tone="green">Sudah</Badge> : <Badge tone="amber">Belum</Badge>}{f.missing.length > (f.doneToday ? 0 : 1) && <div className="text-xs text-rose-600">{f.missing.length} hari terlewat (7 hari)</div>}</td>
                    <td><div className="flex flex-wrap gap-1">
                      <Modal trigger="Sisihkan" triggerClass="btn-secondary btn-sm" title={`Sisihkan ${f.name}`}>
                        <ModalForm action={reserveOne} className="space-y-3">
                          <input type="hidden" name="fundId" value={f.id} />
                          <Field label="Tanggal"><input type="date" name="date" defaultValue={f.missing[f.missing.length - 1] ?? t} className="input" /></Field>
                          <Field label="Nominal" hint="Kosongkan untuk nominal harian"><input name="amount" inputMode="numeric" placeholder={String(Number(f.dailyAmount))} className="input" /></Field>
                          {f.missing.length > 0 && <p className="text-xs text-slate-500">Belum disisihkan: {f.missing.map((d) => fmtDay(new Date(`${d}T00:00:00Z`))).join(", ")}</p>}
                          <Submit>Catat</Submit>
                        </ModalForm>
                      </Modal>
                      {f.kind !== "LOAN_PAYMENT" && f.balance > 0 && (
                        <Modal trigger={f.kind === "OWNER" ? "Ambil" : "Bayar pinjaman"} triggerClass="btn-secondary btn-sm" title={f.kind === "OWNER" ? `Pengambilan ${f.name}` : `Bayar pinjaman dari ${f.name}`}>
                          <ModalForm action={withdraw} className="space-y-3">
                            <input type="hidden" name="fundId" value={f.id} />
                            <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
                            <Field label={`Nominal (saldo ${idr(f.balance)})`}><input name="amount" defaultValue={f.balance} inputMode="numeric" className="input" /></Field>
                            <Field label="Catatan"><input name="note" className="input" /></Field>
                            <Submit>Bukukan</Submit>
                          </ModalForm>
                        </Modal>
                      )}
                      <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${f.name}`}>{fundForm(f)}</Modal>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table></Paged>
          </div>
          <p className="mt-3 text-xs text-slate-500">Kompensasi owner dicatat sebagai beban (mengurangi laba) dan uangnya dipindah ke ShopeePay sebagai titipan owner sampai diambil. Tabungan cicilan hanya memindahkan uang; utang berkurang saat dibayarkan.</p>
        </Card>
      )}
      <Card title="Riwayat terakhir">
        <ul className="divide-y divide-slate-100 text-sm">
          {recent.map((e) => <li key={e.id} className="flex justify-between py-1.5"><span>{fmtDay(e.date)} · {e.fund.name} · {e.type === "SISIH" ? "disisihkan" : e.fund.kind === "OWNER" ? "diambil" : "dibayar ke pinjaman"}{e.note && ` · ${e.note}`}</span><span className={`tabular-nums ${e.type === "TARIK" ? "text-rose-600" : ""}`}>{idr(e.amount)}</span></li>)}
        </ul>
      </Card>
    </div>
  );
}
