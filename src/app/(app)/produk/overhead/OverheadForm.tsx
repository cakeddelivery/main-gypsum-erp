"use client";
import { useState } from "react";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { OVERHEAD_CATEGORIES, monthlyDepreciation, overheadPerPcs } from "@/lib/pricing";
import { saveOverhead } from "../actions";

export type OverheadData = { id: string; name: string; category: string; monthlyAmount: number; outputPerMonth: number; assetCost: number | null; lifeMonths: number | null; note: string | null; active: boolean };

const num = (v: string) => Number(v.replace(/\./g, "").replace(",", ".")) || 0;

/** Form overhead: beban per pcs dihitung langsung dari biaya per bulan / estimasi output */
export function OverheadForm({ o, capacity }: { o?: OverheadData; capacity: number }) {
  const [monthly, setMonthly] = useState(o ? String(o.monthlyAmount) : "");
  const [output, setOutput] = useState(o?.outputPerMonth ? String(o.outputPerMonth) : capacity ? String(capacity) : "");
  const [asset, setAsset] = useState(o?.assetCost ? String(o.assetCost) : "");
  const [life, setLife] = useState(o?.lifeMonths ? String(o.lifeMonths) : "");
  const dep = num(asset) > 0 && num(life) > 0 ? monthlyDepreciation(num(asset), num(life)) : 0;
  const perMonth = dep || num(monthly);
  const perPcs = overheadPerPcs(perMonth, num(output));
  return (
    <ModalForm action={saveOverhead} className="space-y-3">
      {o && <input type="hidden" name="id" value={o.id} />}
      <Field label="Nama Overhead Produksi"><input name="name" defaultValue={o?.name ?? ""} className="input" placeholder="Cth: Biaya Listrik Produksi / Penyusutan Cetakan" /></Field>
      <Field label="Kategori Overhead"><select name="category" defaultValue={o?.category ?? ""} className="input" required><option value="" disabled>— pilih kategori —</option>{OVERHEAD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Estimasi Biaya / Bulan (Rp)"><input name="monthlyAmount" inputMode="numeric" value={dep ? String(dep) : monthly} readOnly={!!dep} onChange={(e) => setMonthly(e.target.value)} className="input" placeholder="Cth: 300000" /></Field>
        <Field label="Est. Output / Bulan (Pcs)"><input name="outputPerMonth" inputMode="numeric" value={output} onChange={(e) => setOutput(e.target.value)} className="input" placeholder="Cth: 3000" /></Field>
      </div>
      <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <span>Beban Overhead Per Pcs:</span><span>Rp {perPcs.toLocaleString("id-ID", { maximumFractionDigits: 2 })} / pcs</span>
      </div>
      <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" open={!!dep}>
        <summary className="cursor-pointer text-sm font-medium">Penyusutan oven / cetakan (opsional)</summary>
        <p className="mt-2 text-xs text-slate-500">Isi harga aset dan umur pakainya, biaya per bulan dihitung otomatis.</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Harga aset (Rp)"><input name="assetCost" inputMode="numeric" value={asset} onChange={(e) => setAsset(e.target.value)} className="input" /></Field>
          <Field label="Umur (bulan)"><input name="lifeMonths" inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)} className="input" /></Field>
        </div>
      </details>
      <Field label="Catatan"><input name="note" defaultValue={o?.note ?? ""} className="input" placeholder="Opsional" /></Field>
      {o && <Field label="Status"><select name="active" defaultValue={o.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Submit>Simpan Overhead</Submit>
    </ModalForm>
  );
}
