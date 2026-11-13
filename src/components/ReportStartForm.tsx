"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalForm } from "./ModalForm";
import { Submit } from "./ActionForm";
import { openReport } from "@/app/(app)/laporan/actions";

type Shift = { id: string; name: string; startTime: string; endTime: string };
export type ReportStartData = {
  today: string;
  divisions: { id: string; name: string; shiftCount: number }[];
  shifts: Shift[];
  /** Anggota divisi: tanggal, divisi, dan shift diisi otomatis tanpa ditampilkan */
  auto?: boolean;
};

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Shift yang sedang berjalan menurut jam di HP; bila di luar jam shift, shift yang jam mulainya paling dekat */
export function currentShift(shifts: Shift[], now = new Date()): Shift | undefined {
  if (!shifts.length) return undefined;
  const t = now.getHours() * 60 + now.getMinutes();
  const inside = shifts.find((s) => {
    const a = mins(s.startTime), b = mins(s.endTime);
    return a <= b ? t >= a && t < b : t >= a || t < b; // shift malam melewati tengah malam
  });
  if (inside) return inside;
  const dist = (s: Shift) => Math.min(Math.abs(t - mins(s.startTime)), 1440 - Math.abs(t - mins(s.startTime)));
  return [...shifts].sort((x, y) => dist(x) - dist(y))[0];
}

/**
 * Pilih tanggal, divisi, shift → buka (atau buat) draf laporan shift.
 * go="isi" membuka form laporan, go="masuk" membuka popup Barang masuk laporan itu.
 * Mode otomatis (anggota): semua terisi sendiri dan langsung dibuka.
 */
export function ReportStartForm({ data, go = "isi" }: { data: ReportStartData; go?: "isi" | "masuk" }) {
  const { divisions, shifts, today } = data;
  const [div, setDiv] = useState(divisions.length === 1 ? divisions[0].id : "");
  const d = divisions.find((x) => x.id === div);
  const shiftOpts = useMemo(() => (d ? shifts.slice(0, Math.max(1, d.shiftCount)) : shifts), [d, shifts]);
  // Hitung shift dari jam HP setelah tampil di browser (bukan di server)
  const [guess, setGuess] = useState<string>("");
  useEffect(() => setGuess(currentShift(shiftOpts)?.id ?? ""), [shiftOpts]);
  const auto = !!data.auto && divisions.length === 1 && !!guess;
  const formWrap = useRef<HTMLDivElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (!auto || sent.current) return;
    sent.current = true;
    formWrap.current?.querySelector("form")?.requestSubmit();
  }, [auto]);

  if (!divisions.length) return <p className="text-sm text-slate-500">Akun ini belum terhubung ke divisi. Minta Owner mengatur divisi di menu Karyawan / Pengguna.</p>;
  const shiftName = shiftOpts.find((s) => s.id === guess)?.name;
  return (
    <div ref={formWrap}>
      <ModalForm action={openReport} className="space-y-3">
        <input type="hidden" name="go" value={go} />
        {auto ? (
          <>
            <input type="hidden" name="date" value={today} />
            <input type="hidden" name="divisionId" value={divisions[0].id} />
            <input type="hidden" name="shiftId" value={guess} />
            <div className="flex items-center gap-3 py-2 text-sm text-slate-600">
              <span className="btn-spinner text-brand-600" aria-hidden />
              Membuka laporan {divisions[0].name}{shiftName ? ` · ${shiftName}` : ""} hari ini…
            </div>
            <div className="hidden"><Submit>Buka</Submit></div>
          </>
        ) : (
          <>
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
              <select key={`${div}-${guess}`} name="shiftId" className="input" required defaultValue={guess}>
                {!guess && <option value="" disabled>— pilih shift —</option>}
                {shiftOpts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
              </select>
              {guess && <span className="mt-1 block text-xs text-slate-500">Dipilih otomatis sesuai jam sekarang</span>}
            </label>
            <Submit pendingText="Membuka…">{go === "masuk" ? "Lanjut catat barang masuk" : "Lanjut isi laporan"}</Submit>
          </>
        )}
      </ModalForm>
    </div>
  );
}
