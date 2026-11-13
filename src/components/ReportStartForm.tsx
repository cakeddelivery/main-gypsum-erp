"use client";
import { useState } from "react";
import { ModalForm } from "./ModalForm";
import { Submit } from "./ActionForm";
import { openReport } from "@/app/(app)/laporan/actions";

export type ReportStartData = {
  today: string;
  divisions: { id: string; name: string; shiftCount: number }[];
  shifts: { id: string; name: string; startTime: string; endTime: string }[];
};

/**
 * Pilih tanggal, divisi, shift → buka (atau buat) draf laporan shift.
 * go="isi" membuka form laporan, go="masuk" membuka popup Barang masuk laporan itu.
 */
export function ReportStartForm({ data, go = "isi" }: { data: ReportStartData; go?: "isi" | "masuk" }) {
  const { divisions, shifts, today } = data;
  const [div, setDiv] = useState(divisions.length === 1 ? divisions[0].id : "");
  const d = divisions.find((x) => x.id === div);
  const shiftOpts = d ? shifts.slice(0, Math.max(1, d.shiftCount)) : shifts;
  if (!divisions.length) return <p className="text-sm text-slate-500">Akun ini belum terhubung ke divisi. Minta Owner mengatur divisi di menu Karyawan / Pengguna.</p>;
  return (
    <ModalForm action={openReport} className="space-y-3">
      <input type="hidden" name="go" value={go} />
      <p className="text-sm text-slate-500">{go === "masuk" ? "Barang masuk dicatat ke laporan shift ini (isi sebelum menghitung stok akhir)." : "Pilih laporan yang akan diisi. Bila laporan itu sudah ada, isiannya dilanjutkan."}</p>
      <label className="block">
        <span className="label">Tanggal</span>
        <input type="date" name="date" defaultValue={today} max={today} className="input" required />
      </label>
      {divisions.length === 1 ? (
        <>
          <input type="hidden" name="divisionId" value={divisions[0].id} />
          <p className="text-sm">Divisi: <b>{divisions[0].name}</b></p>
        </>
      ) : (
        <label className="block">
          <span className="label">Divisi</span>
          <select name="divisionId" className="input" required value={div} onChange={(e) => setDiv(e.target.value)}>
            <option value="" disabled>— pilih divisi —</option>
            {divisions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      <label className="block">
        <span className="label">Shift</span>
        <select key={div} name="shiftId" className="input" required defaultValue={shiftOpts.length === 1 ? shiftOpts[0].id : ""}>
          {shiftOpts.length > 1 && <option value="" disabled>— pilih shift —</option>}
          {shiftOpts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
        </select>
      </label>
      <Submit pendingText="Membuka…">{go === "masuk" ? "Lanjut catat barang masuk" : "Lanjut isi laporan"}</Submit>
    </ModalForm>
  );
}
