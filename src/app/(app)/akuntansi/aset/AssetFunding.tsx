"use client";
import { useState } from "react";

type Bank = { id: string; name: string };
type Supplier = { id: string; name: string };

/**
 * Tanggal perolehan + sumber dana. Aset yang dibeli sebelum go-live otomatis memakai "Saldo awal (aset lama)",
 * karena uangnya keluar sebelum memakai aplikasi (sudah termasuk saldo awal rekening).
 */
export function AssetFunding({ banks, goLive, today, suppliers = [] }: { banks: Bank[]; goLive: string; today: string; suppliers?: Supplier[] }) {
  const [date, setDate] = useState(today);
  const old = date < goLive;
  const [funding, setFunding] = useState(old ? "SALDO_AWAL" : banks[0]?.id ?? "UTANG");
  return (
    <>
      <label className="block">
        <span className="label">Tanggal perolehan</span>
        <input
          type="date"
          name="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            if (e.target.value && e.target.value < goLive) setFunding("SALDO_AWAL");
          }}
          className="input"
        />
      </label>
      <label className="col-span-2 block">
        <span className="label">Sumber dana</span>
        <select name="funding" value={funding} onChange={(e) => setFunding(e.target.value)} className="input">
          <option value="SALDO_AWAL">Saldo awal (aset lama, sebelum memakai aplikasi)</option>
          {banks.map((b) => <option key={b.id} value={b.id} disabled={old}>Dibayar dari {b.name}</option>)}
          <option value="UTANG">Hutang usaha</option>
        </select>
        {old && (
          <span className="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            Dibeli sebelum go-live ({goLive}): uangnya sudah keluar sebelum memakai aplikasi, jadi tidak boleh mengurangi saldo rekening. Pakai &quot;Saldo awal&quot;.
          </span>
        )}
      </label>
      {funding === "UTANG" && (
        <>
          <label className="col-span-2 block">
            <span className="label">Pemasok (penjual aset)</span>
            <input name="vendor" list="aset-supplier" className="input" required placeholder="Ketik atau pilih supplier" />
            <datalist id="aset-supplier">{suppliers.map((s) => <option key={s.id} value={s.name} />)}</datalist>
          </label>
          <label className="col-span-2 block">
            <span className="label">Jatuh tempo hutang</span>
            <input type="date" name="dueDate" min={date} className="input" required />
            <span className="mt-1 block text-xs text-slate-500">Hutangnya otomatis masuk Akuntansi → Piutang &amp; hutang, bisa dicicil dan diingatkan saat jatuh tempo.</span>
          </label>
        </>
      )}
    </>
  );
}
