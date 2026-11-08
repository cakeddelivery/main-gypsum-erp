import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, todayStr } from "@/lib/time";
import { letterhead } from "@/lib/letterhead";
import { saleStatus } from "@/lib/sales";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProofPreview } from "@/components/ProofPreview";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocBar, DocExport, DocSection, DocSheet, DocSummary, DocTable, fmtLong } from "@/components/DocSheet";
import { cancelSaleAction, cancelSalePaymentAction, receiveSalePayment } from "../actions";

export const metadata = { title: "Detail Penjualan" };

const qtyFmt = (v: { toString(): string }) => Number(v.toString()).toLocaleString("id-ID");

export default async function PenjualanDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("sales.view");
  const { id } = await params;
  const s = await prisma.sale.findUnique({ where: { id }, include: { store: true, customer: true, lines: { include: { item: true } }, payments: { include: { bank: true }, orderBy: { date: "asc" } }, receivable: true } });
  if (!s) notFound();
  const canManage = user.can("sales.manage");
  const st = saleStatus(s);
  const rest = Number(s.total - s.paid);
  const pays = s.payments.filter((p) => !p.cancelledAt);
  const hasInstallment = pays.some((p) => !p.initial);
  const banks = canManage ? await prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, orderBy: { code: "asc" } }) : [];
  const lh = await letterhead();
  const info: [string, React.ReactNode][] = [
    ["No. nota", s.number], ["Tanggal", fmtLong(s.date)], ["Toko", s.store.name],
    ["Pelanggan", s.customerName], ...(s.customer?.phone ? [["No. HP", s.customer.phone] as [string, string]] : []),
    ...(s.customer?.address ? [["Alamat", s.customer.address] as [string, string]] : []),
    ["Status", st.label], ...(rest > 0 && !s.cancelledAt && s.dueDate ? [["Jatuh tempo", fmtLong(s.dueDate)] as [string, string]] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Penjualan ${s.number}`}
        subtitle={<>{s.customerName} · {fmtDate(s.date)} · <Badge tone={st.tone}>{st.label}</Badge></>}
        actions={<>
          <Link href="/penjualan" className="btn-secondary">Kembali</Link>
          {!s.cancelledAt && <DownloadJpg targetId="nota" filename={`nota-${s.number}`} />}
          {canManage && !s.cancelledAt && rest > 0 && (
            <Modal trigger="Terima pembayaran" title={`Pembayaran ${s.number}`}>
              <ModalForm action={receiveSalePayment} className="space-y-3">
                <input type="hidden" name="id" value={s.id} />
                <p className="text-sm">Sisa tagihan <b>{idr(rest)}</b></p>
                <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" required /></Field>
                <Field label="Nominal (Rp)"><input name="amount" inputMode="numeric" defaultValue={rest} className="input" required /></Field>
                <Field label="Masuk ke rekening"><select name="bankAccountId" className="input" defaultValue={banks.find((b) => b.code === "SEABANK")?.id ?? banks[0]?.id}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                <Field label="Bukti bayar (opsional)"><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full min-w-0 max-w-full text-base" /></Field>
                <Field label="Catatan"><input name="note" className="input" /></Field>
                <Submit>Simpan pembayaran</Submit>
              </ModalForm>
            </Modal>
          )}
          {canManage && !s.cancelledAt && !hasInstallment && (
            <Modal trigger="Batalkan" triggerClass="btn-secondary" title={`Batalkan ${s.number}`}>
              <ModalForm action={cancelSaleAction} className="space-y-3">
                <input type="hidden" name="id" value={s.id} />
                <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                <p className="text-xs text-slate-500">Jurnal penjualan & HPP dibalik, barang jadi kembali ke gudang, dan piutangnya dihapus. Catat ulang bila perlu.</p>
                <Submit className="btn-danger">Batalkan penjualan</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      {s.cancelledAt && <p className="rounded-lg bg-slate-100 p-3 text-sm">Dibatalkan {fmtDate(s.cancelledAt)}{s.cancelReason ? `: ${s.cancelReason}` : ""}</p>}

      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <Card title="Barang" className="lg:col-span-2">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Barang</th><th className="num">Jumlah</th><th className="num">Harga</th><th className="num">Total</th><th className="num">HPP</th></tr></thead>
              <tbody>
                {s.lines.map((l) => (
                  <tr key={l.id}><td>{l.item.name}</td><td className="num">{qtyFmt(l.qty)} {l.item.unit}</td><td className="num">{idr(l.price)}</td><td className="num">{idr(l.amount)}</td><td className="num text-slate-500">{idr(Math.round(Number(l.qty) * Number(l.unitCost)))}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Ringkasan">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-slate-500">Jumlah harga</dt><dd className="text-right">{idr(s.subtotal)}</dd>
            {s.discount > BigInt(0) && <><dt className="text-slate-500">Diskon</dt><dd className="text-right text-rose-600">−{idr(s.discount)}</dd></>}
            {s.shipping > BigInt(0) && <><dt className="text-slate-500">Ongkir</dt><dd className="text-right">{idr(s.shipping)}</dd></>}
            <dt className="font-semibold">Tagihan</dt><dd className="text-right font-semibold">{idr(s.total)}</dd>
            <dt className="text-slate-500">Dibayar</dt><dd className="text-right">{idr(s.paid)}</dd>
            <dt className="text-slate-500">Sisa</dt><dd className="text-right">{idr(Math.max(0, rest))}</dd>
            <dt className="text-slate-500">HPP</dt><dd className="text-right">{idr(s.hpp)}</dd>
            <dt className="text-slate-500">Laba kotor</dt><dd className="text-right">{idr(Number(s.total) - Number(s.shipping) - Number(s.hpp))}</dd>
            {s.dueDate && <><dt className="text-slate-500">Jatuh tempo</dt><dd className="text-right">{fmtDate(s.dueDate)}</dd></>}
            {s.receivable && <><dt className="text-slate-500">Piutang</dt><dd className="text-right font-mono text-xs">{s.receivable.number}</dd></>}
          </dl>
          {s.note && <p className="mt-2 text-xs text-slate-500">{s.note}</p>}
          <p className="mt-2 text-xs text-slate-400">Dicatat oleh {s.createdBy}</p>
        </Card>
      </div>

      <Card title="Pembayaran">
        {s.payments.length === 0 ? <p className="text-sm text-slate-500">Belum ada pembayaran.</p> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Tanggal</th><th>Jenis</th><th>Rekening</th><th className="num">Nominal</th><th>Bukti</th><th /></tr></thead>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id} className={p.cancelledAt ? "opacity-60" : ""}>
                    <td>{fmtDate(p.date)}</td>
                    <td>{p.initial ? "Saat penjualan" : "Cicilan"}{p.cancelledAt && <> · <Badge tone="gray">Dibatalkan</Badge></>}{p.note && <div className="text-xs text-slate-500">{p.note}</div>}</td>
                    <td>{p.bank.name}</td>
                    <td className="num">{idr(p.amount)}</td>
                    <td>{p.proofPath ? <ProofPreview src={`/api/files/sale-proof/${p.id}`} mime={p.proofMime} title={`Bukti ${s.number}`} /> : <span className="text-slate-400">-</span>}</td>
                    <td>{canManage && !p.initial && !p.cancelledAt && !s.cancelledAt && (
                      <Modal trigger="Batalkan" triggerClass="btn-secondary btn-sm" title="Batalkan cicilan">
                        <ModalForm action={cancelSalePaymentAction} className="space-y-3">
                          <input type="hidden" name="id" value={p.id} />
                          <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                          <p className="text-xs text-slate-500">Jurnal cicilan dibalik dan sisa piutang kembali bertambah.</p>
                          <Submit className="btn-danger">Batalkan cicilan</Submit>
                        </ModalForm>
                      </Modal>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!s.cancelledAt && (
        <DocExport>
          <DocSheet
            id="nota" lh={lh} exportWidth={900} eyebrow="Nota penjualan" title={rest > 0 ? "Invoice" : "Nota Penjualan"}
            subtitle={`${s.customerName} · ${s.store.name}`}
            meta={{ label: "No. nota", value: s.number }}
            signer="Admin Penjualan" signDate={todayStr(s.date)}
            notes={[
              ...(rest > 0 ? [`Sisa tagihan ${idr(rest)}${s.dueDate ? `, jatuh tempo ${fmtLong(s.dueDate)}` : ""}.`] : ["Terima kasih, pembayaran sudah lunas."]),
              ...(s.note ? [s.note] : []),
              "Nota ini dihasilkan secara otomatis dari sistem dan sah tanpa tanda tangan basah.",
            ]}
          >
            <DocSection title="Data penjualan">
              <dl className="doc-kv">{info.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
            </DocSection>
            <DocSection no={1} tone="blue" title="Barang">
              <DocTable head={<tr><th>Barang</th><th className="num">Jumlah</th><th className="num">Harga (Rp)</th><th className="num">Total (Rp)</th></tr>}>
                {s.lines.map((l) => <tr key={l.id}><td>{l.item.name}</td><td className="num">{qtyFmt(l.qty)} {l.item.unit}</td><td className="num">{Number(l.price).toLocaleString("id-ID")}</td><td className="num">{Number(l.amount).toLocaleString("id-ID")}</td></tr>)}
              </DocTable>
              <DocBar label="Jumlah harga barang" value={idr(s.subtotal)} />
              {s.discount > BigInt(0) && <DocBar label="Diskon" value={`-${idr(s.discount)}`} tone="red" negative />}
              {s.shipping > BigInt(0) && <DocBar label="Ongkir" value={idr(s.shipping)} />}
            </DocSection>
            {pays.length > 0 && (
              <DocSection no={2} tone="green" title="Pembayaran">
                <DocTable head={<tr><th>Tanggal</th><th>Rekening</th><th className="num">Nominal (Rp)</th></tr>}>
                  {pays.map((p) => <tr key={p.id}><td>{fmtLong(p.date)}</td><td>{p.bank.name}</td><td className="num">{Number(p.amount).toLocaleString("id-ID")}</td></tr>)}
                </DocTable>
              </DocSection>
            )}
            <DocSummary rows={[
              { label: "Total tagihan", value: idr(s.total), strong: rest <= 0 },
              { label: "Sudah dibayar", value: idr(s.paid) },
              ...(rest > 0 ? [{ label: "Sisa tagihan", hint: s.dueDate ? `Jatuh tempo ${fmtLong(s.dueDate)}` : undefined, value: idr(rest), strong: true }] : []),
            ]} />
          </DocSheet>
        </DocExport>
      )}
    </div>
  );
}
