import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { idr } from "@/lib/money";
import { monthKey, monthLabel, parseMonth, prevMonth } from "@/lib/budget";
import { MP_FEE_FIELDS, marketplaceMonthSummary } from "@/lib/marketplaceMonthly";
import { Empty, Field, PageHeader, Stat } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { saveMarketplaceMonthAction } from "./actions";
import type { SP } from "../shared";

export const metadata = { title: "Biaya Marketplace" };

/**
 * Biaya marketplace bulanan: angka potongan dari "Laporan Penghasilan" Shopee/TikTok Seller Center dicatat sebulan sekali
 * per saldo penjual & toko, agar Penjualan = omzet kotor dan biaya admin/komisi terlihat. Laba tidak berubah.
 */
export default async function MarketplacePage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("accounting.view");
  const sp = await searchParams;
  const { year, month } = parseMonth(sp.bulan);
  const key = monthKey(year, month);
  const prev = prevMonth(year, month);
  const { rows, banks, stores } = await marketplaceMonthSummary(year, month);
  const canEdit = user.can("accounting.post");
  const period = monthLabel(year, month);
  const sum = (k: "net" | "grossBook") => rows.reduce((s, r) => s + r[k], 0);
  const feeSum = rows.reduce((s, r) => s + (r.fees ?? 0), 0);
  const missing = rows.filter((r) => r.net > 0 && r.fees === null).length;

  const form = (r?: (typeof rows)[number]) => (
    <ModalForm action={saveMarketplaceMonthAction} className="grid grid-cols-2 gap-3">
      <input type="hidden" name="month" value={key} />
      <Field label="Bulan" className="col-span-2"><input className="input" value={period} readOnly disabled /></Field>
      <Field label="Saldo penjual">
        <select name="bankId" className="input" defaultValue={r?.bank.id ?? banks[0]?.id} required>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </Field>
      <Field label="Toko">
        <select name="storeId" className="input" defaultValue={r?.store.id ?? stores[0]?.id} required>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </Field>
      <Field label="Omzet kotor menurut marketplace (opsional)" className="col-span-2" hint="Total harga pesanan di Laporan Penghasilan; dipakai untuk cek % biaya">
        <input name="gross" inputMode="numeric" className="input" defaultValue={r?.saved?.gross?.toLocaleString("id-ID") ?? ""} />
      </Field>
      {MP_FEE_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} className="col-span-2">
          <input name={f.key} inputMode="numeric" className="input" defaultValue={r?.saved?.fees[f.key] ? r.saved.fees[f.key].toLocaleString("id-ID") : ""} placeholder="0" />
        </Field>
      ))}
      <Field label="Catatan (opsional)" className="col-span-2"><input name="note" className="input" defaultValue={r?.saved?.note ?? ""} /></Field>
      <p className="col-span-2 text-xs text-slate-500">Dibukukan Dr Beban Admin & Layanan Platform / Cr Penjualan, bertanggal akhir bulan (bila bulan sudah tutup buku: hari ini). Laba tidak berubah. Menyimpan ulang mengganti catatan lama.</p>
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );

  return (
    <div>
      <PageHeader
        title="Biaya marketplace bulanan"
        subtitle={`${period} · potongan Shopee/TikTok dari Laporan Penghasilan Seller Center`}
        actions={<>
          <Link href={`?bulan=${monthKey(prev.year, prev.month)}`} className="btn-secondary">‹ {monthLabel(prev.year, prev.month)}</Link>
          {canEdit && banks.length > 0 && <Modal trigger="+ Catat biaya" title={`Biaya marketplace ${period}`}>{form()}</Modal>}
        </>}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Penjualan dari withdraw (neto)" value={idr(sum("net"))} />
        <Stat label="Biaya marketplace dicatat" value={idr(feeSum)} />
        <Stat label="Omzet kotor tercatat" value={idr(sum("grossBook"))} />
        <Stat label="Belum dicatat" value={`${missing} saldo penjual`} tone={missing ? "red" : "green"} />
      </div>
      {rows.length === 0 ? <Empty title="Belum ada withdraw marketplace di bulan ini" /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Saldo penjual</th><th>Toko</th><th className="num">Withdraw (neto)</th><th className="num">Biaya</th><th className="num">Omzet kotor tercatat</th><th className="num">Omzet menurut marketplace</th><th className="num">% biaya</th>{canEdit && <th />}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.bank.id}:${r.store.id}`}>
                <td>{r.bank.name}</td><td>{r.store.code}</td><td className="num">{idr(r.net)}</td>
                <td className="num">{r.fees === null ? <span className="text-rose-600">belum</span> : idr(r.fees)}</td>
                <td className="num">{idr(r.grossBook)}</td><td className="num">{r.grossMarket ? idr(r.grossMarket) : "-"}</td>
                <td className="num">{r.feePct != null ? `${r.feePct.toLocaleString("id-ID")}%` : "-"}</td>
                {canEdit && <td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Biaya ${r.bank.name} ${r.store.code} ${period}`}>{form(r)}</Modal></td>}
              </tr>
            ))}</tbody>
          </table></Paged>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">Omzet kotor tercatat = withdraw (neto) + biaya. Bisa sedikit berbeda dengan omzet menurut marketplace karena withdraw tidak selalu di bulan yang sama dengan pesanannya.</p>
    </div>
  );
}
