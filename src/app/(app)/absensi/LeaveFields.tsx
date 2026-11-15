"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

/** Isian pengajuan izin/sakit. Lampiran jadi wajib otomatis untuk sakit lebih dari 1 hari. */
export function LeaveFields({ today, min, maxDays }: { today: string; min: string; maxDays: number }) {
  const [kind, setKind] = useState("IZIN");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const multi = !!to && to !== from;
  const needDoc = kind === "SAKIT" && multi;
  return (
    <>
      <Field label="Jenis">
        <select name="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="IZIN">Izin</option>
          <option value="SAKIT">Sakit</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3 keep-cols">
        <Field label="Tanggal"><input type="date" name="dateFrom" className="input" required min={min} value={from} onChange={(e) => { setFrom(e.target.value); if (to && to < e.target.value) setTo(""); }} /></Field>
        <Field label="Sampai (opsional)"><input type="date" name="dateTo" className="input" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <p className="-mt-1 text-xs text-slate-500">Kosongkan &quot;Sampai&quot; bila hanya 1 hari. Paling lama {maxDays} hari.</p>
      <Field label="Alasan"><textarea name="reason" className="input" rows={3} required minLength={3} placeholder={kind === "SAKIT" ? "Mis. demam, periksa ke dokter" : "Mis. acara keluarga"} /></Field>
      <Field label={needDoc ? "Foto surat dokter (wajib)" : kind === "SAKIT" ? "Foto surat dokter (opsional untuk 1 hari)" : "Foto bukti (opsional)"}>
        <label className={`input flex cursor-pointer items-center gap-2 ${needDoc && !file ? "border-amber-400" : ""}`}>
          <span aria-hidden>📷</span>
          <span className="truncate text-slate-600">{file ?? "Ambil / pilih foto"}</span>
          <input type="file" name="attachment" accept="image/*,application/pdf" className="sr-only" required={needDoc} onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
        </label>
      </Field>
      {needDoc && <p className="-mt-1 text-xs text-amber-700">Sakit lebih dari 1 hari wajib melampirkan surat dokter.</p>}
    </>
  );
}
