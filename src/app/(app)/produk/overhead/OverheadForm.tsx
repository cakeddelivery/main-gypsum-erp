"use client";
import { useState } from "react";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { OVERHEAD_CATEGORIES, monthlyDepreciation, overheadPerPcs } from "@/lib/pricing";
import { saveOverhead } from "../actions";

export type OverheadData = { id: string; name: string; category: string; monthlyAmount: number; outputPerMonth: number; assetCost: number | null; lifeMonths: number | null; note: string | null; active: boolean; autoSalary: boolean; salaryDivisionIds: string[] };
/** Biaya gaji per bulan per divisi (gaji pokok + tunjangan + BPJS TK), untuk pratinjau overhead gaji otomatis */
export type SalaryDivision = { id: string; name: string; total: number; employees: number; preset: boolean };

const num = (v: string) => Number(v.replace(/\./g, "").replace(",", ".")) || 0;

/** Form overhead: beban per pcs dihitung langsung dari biaya per bulan / estimasi output */
export function OverheadForm({ o, capacity, salary }: { o?: OverheadData; capacity: number; salary: SalaryDivision[] }) {
  const [category, setCategory] = useState(o?.category ?? "");
  const [auto, setAuto] = useState(o?.autoSalary ?? false);
  const [divs, setDivs] = useState<Set<string>>(() => new Set(o?.salaryDivisionIds.length ? o.salaryDivisionIds : salary.filter((d) => d.preset).map((d) => d.id)));
  const salaryTotal = salary.filter((d) => divs.has(d.id)).reduce((s, d) => s + d.total, 0);
  const [monthly, setMonthly] = useState(o ? String(o.monthlyAmount) : "");
  const [output, setOutput] = useState(o?.outputPerMonth ? String(o.outputPerMonth) : capacity ? String(capacity) : "");
  const [asset, setAsset] = useState(o?.assetCost ? String(o.assetCost) : "");
  const [life, setLife] = useState(o?.lifeMonths ? String(o.lifeMonths) : "");
  const dep = num(asset) > 0 && num(life) > 0 ? monthlyDepreciation(num(asset), num(life)) : 0;
  const perMonth = auto ? salaryTotal : dep || num(monthly);
  const perPcs = overheadPerPcs(perMonth, num(output));
  return (
    <ModalForm action={saveOverhead} className="space-y-3">
      {o && <input type="hidden" name="id" value={o.id} />}
      <Field label="Nama Overhead Produksi"><input name="name" defaultValue={o?.name ?? ""} className="input" placeholder="Cth: Biaya Listrik Produksi / Penyusutan Cetakan" /></Field>
      <Field label="Kategori Overhead"><select name="category" value={category} onChange={(e) => { setCategory(e.target.value); if (e.target.value === "Gaji Produksi") setAuto(true); }} className="input" required><option value="" disabled>— pilih kategori —</option>{OVERHEAD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
      {(category === "Gaji Produksi" || auto) && (
        <div className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/20">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="autoSalary" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Otomatis dari gaji karyawan</label>
          {auto && (
            <>
              <p className="text-xs text-slate-600 dark:text-slate-300">Biaya per bulan = gaji pokok + tunjangan + BPJS TK karyawan divisi terpilih (pekerja borongan tidak dihitung). Ikut berubah otomatis saat gaji, tunjangan, BPJS, atau karyawan berubah. Hanya untuk HPP & saran harga, tidak membuat jurnal.</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {salary.map((d) => (
                  <label key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-sm dark:bg-slate-900">
                    <span className="flex items-center gap-2"><input type="checkbox" name="salaryDivisionIds" value={d.id} checked={divs.has(d.id)} onChange={(e) => setDivs((cur) => { const n = new Set(cur); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />{d.name}</span>
                    <span className="text-xs text-slate-500">{d.employees} org · Rp {d.total.toLocaleString("id-ID")}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Estimasi Biaya / Bulan (Rp)"><input name="monthlyAmount" inputMode="numeric" value={auto ? String(salaryTotal) : dep ? String(dep) : monthly} readOnly={!!dep || auto} onChange={(e) => setMonthly(e.target.value)} className="input" placeholder="Cth: 300000" /></Field>
        <Field label="Est. Output / Bulan (Pcs)"><input name="outputPerMonth" inputMode="numeric" value={output} onChange={(e) => setOutput(e.target.value)} className="input" placeholder="Cth: 3000" /></Field>
      </div>
      <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <span>Beban Overhead Per Pcs:</span><span>Rp {perPcs.toLocaleString("id-ID", { maximumFractionDigits: 2 })} / pcs</span>
      </div>
      {!auto && <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" open={!!dep}>
        <summary className="cursor-pointer text-sm font-medium">Penyusutan oven / cetakan (opsional)</summary>
        <p className="mt-2 text-xs text-slate-500">Isi harga aset dan umur pakainya, biaya per bulan dihitung otomatis.</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Harga aset (Rp)"><input name="assetCost" inputMode="numeric" value={asset} onChange={(e) => setAsset(e.target.value)} className="input" /></Field>
          <Field label="Umur (bulan)"><input name="lifeMonths" inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)} className="input" /></Field>
        </div>
      </details>}
      <Field label="Catatan"><input name="note" defaultValue={o?.note ?? ""} className="input" placeholder="Opsional" /></Field>
      {o && <Field label="Status"><select name="active" defaultValue={o.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Submit>Simpan Overhead</Submit>
    </ModalForm>
  );
}
