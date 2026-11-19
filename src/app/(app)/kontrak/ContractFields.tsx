"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

type Emp = { id: string; name: string; nik: string; address: string; salary: number };

/** Isian draf kontrak: karyawan (data master terisi otomatis), lama kontrak, mulai, gaji pokok, NIK, alamat */
export function ContractFields({ mode, durations, today, employees, initial }: { mode: "create" | "edit"; durations: number[]; today: string; employees?: Emp[]; initial?: { months: number; start: string; baseSalary: number; nik: string; address: string } }) {
  const [empId, setEmpId] = useState("");
  const e = employees?.find((x) => x.id === empId);
  const [months, setMonths] = useState(initial?.months ?? durations.find((d) => d === 6) ?? durations[0]);
  return (
    <>
      {mode === "create" && (
        <Field label="Karyawan">
          <select name="employeeId" className="input" required value={empId} onChange={(ev) => setEmpId(ev.target.value)}>
            <option value="">— pilih karyawan —</option>
            {employees!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Lama kontrak">
        <select name="months" className="input" value={months} onChange={(ev) => setMonths(Number(ev.target.value))}>
          {durations.map((d) => <option key={d} value={d}>{d} bulan</option>)}
        </select>
      </Field>
      <Field label="Mulai berlaku"><input type="date" name="start" className="input" required defaultValue={initial?.start ?? today} /></Field>
      <Field label="Gaji pokok per bulan (Rp)"><input name="baseSalary" className="input" inputMode="numeric" required key={`g${empId}`} defaultValue={initial?.baseSalary ?? (e?.salary || "")} placeholder="mis. 1000000" /></Field>
      <Field label="NIK (16 digit)"><input name="nik" className="input" inputMode="numeric" maxLength={16} required key={`n${empId}`} defaultValue={initial?.nik ?? e?.nik ?? ""} /></Field>
      <Field label="Alamat"><textarea name="address" className="input" rows={2} required key={`a${empId}`} defaultValue={initial?.address ?? e?.address ?? ""} /></Field>
      <p className="text-xs text-slate-500">Tunjangan, jadwal shift, dan siklus gaji diambil otomatis dari data karyawan.</p>
    </>
  );
}
