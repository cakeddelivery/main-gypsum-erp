"use client";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { createEntry } from "./actions";
import { REJECT_REASONS } from "@/lib/reject";

type Opt = { id: string; name: string };
export function EntryForm(p: { date: string; shifts: Opt[]; divisions: Opt[]; employees: (Opt & { divisionId: string })[]; products: Opt[]; stages: { value: string; label: string }[]; fixedEmployee?: string | null; fixedDivision?: string | null }) {
  const emp = p.employees.find((e) => e.id === p.fixedEmployee);
  return (
    <ModalForm action={createEntry} className="grid grid-cols-2 gap-3">
      <label className="col-span-1"><span className="label">Tanggal</span><input type="date" name="date" defaultValue={p.date} className="input" required /></label>
      <label><span className="label">Shift</span>
        <select name="shiftId" className="input" required>{p.shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label><span className="label">Divisi</span>
        <select name="divisionId" className="input" required defaultValue={emp?.divisionId ?? p.fixedDivision ?? ""}>
          <option value="" disabled>Pilih…</option>
          {p.divisions.filter((d) => !p.fixedDivision || d.id === p.fixedDivision).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label><span className="label">Karyawan</span>
        <select name="employeeId" className="input" required defaultValue={p.fixedEmployee ?? ""}>
          <option value="" disabled>Pilih…</option>
          {p.employees.filter((e) => (!p.fixedEmployee || e.id === p.fixedEmployee) && (!p.fixedDivision || e.divisionId === p.fixedDivision)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>
      <label><span className="label">Tahap</span>
        <select name="stage" className="input" required>{p.stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      </label>
      <label><span className="label">Produk</span>
        <select name="productId" className="input" required>{p.products.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label><span className="label">Hasil baik (pcs)</span><input name="qtyGood" inputMode="numeric" pattern="[0-9]*" className="input" defaultValue="0" required /></label>
      <label><span className="label">Reject (pcs)</span><input name="qtyReject" inputMode="numeric" pattern="[0-9]*" className="input" defaultValue="0" /></label>
      <label className="col-span-2"><span className="label">Penyebab reject (wajib bila ada reject)</span>
        <select name="rejectReason" className="input" defaultValue=""><option value="">— Tidak ada reject —</option>{REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      </label>
      <label className="col-span-2"><span className="label">Catatan</span><input name="note" className="input" maxLength={300} /></label>
      <div className="col-span-2 flex justify-end"><Submit>Simpan hasil</Submit></div>
    </ModalForm>
  );
}
