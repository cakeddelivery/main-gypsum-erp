"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";
import { useGeo } from "@/components/GeoFields";
import { checkGeofence, distanceMeters, MAX_GPS_ACCURACY } from "@/lib/attendance";
import type { ActionResult } from "@/lib/action";

type Site = { id: string; name: string; latitude: number; longitude: number; radiusM: number };
type Shift = { name: string; startTime: string; endTime: string; toleranceMinutes: number };
type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

const fmtClock = (d: Date) => d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).replace(/\./g, ":");
const fmtHm = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\./g, ":");
const fmtLong = (d: Date) => d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const addMin = (hhmm: string, m: number) => {
  const t = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + m) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
function duration(fromIso: string, to: Date) {
  const m = Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60000));
  return `${Math.floor(m / 60)} j ${m % 60} m`;
}

/** Jam berjalan (detik). Render awal kosong agar tidak beda dengan server. */
function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function Icon({ d, className = "" }: { d: React.ReactNode; className?: string }) {
  return <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>{d}</svg>;
}
const CLOCK = <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>;
const PIN = <><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="10" r="2.6" /></>;
const WARN = <><path d="M12 3l10 18H2L12 3Z" /><path d="M12 10v5M12 18h.01" /></>;

function InfoCard({ icon, tone, eyebrow, title, sub, dot }: { icon: React.ReactNode; tone: "brand" | "emerald" | "amber" | "rose" | "slate"; eyebrow: string; title: string; sub?: string; dot?: "ok" | "wait" | "bad" }) {
  const box = { brand: "bg-brand-50 text-brand-700", emerald: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700", rose: "bg-rose-50 text-rose-700", slate: "bg-slate-100 text-slate-600" }[tone];
  const dotCls = dot === "ok" ? "bg-emerald-500 ring-emerald-100" : dot === "bad" ? "bg-rose-500 ring-rose-100" : "animate-pulse bg-amber-400 ring-amber-100";
  return (
    <div className="card flex items-center gap-4 p-4">
      <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${box}`}><Icon d={icon} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{eyebrow}</div>
        <div className="truncate text-base font-bold text-slate-900">{title}</div>
        {sub && <div className="text-xs text-slate-500">{sub}</div>}
      </div>
      {dot && <span className={`h-3.5 w-3.5 shrink-0 rounded-full ring-4 ${dotCls}`} aria-hidden />}
    </div>
  );
}

/** Status lokasi langsung dari GPS HP (server tetap memeriksa ulang saat tombol ditekan) */
function useLocation(sites: Site[], enabled: boolean) {
  const { fix, error, retry } = useGeo(enabled);
  if (!sites.length) return { fix, retry, ok: true, card: { title: "Lokasi bebas", sub: "Belum ada titik lokasi kerja; lokasi hanya dicatat", dot: "ok" as const, tone: "emerald" as const } };
  if (error) return { fix, retry, ok: false, error, card: { title: "GPS belum terbaca", sub: error, dot: "bad" as const, tone: "rose" as const } };
  if (!fix) return { fix, retry, ok: false, card: { title: "Membaca lokasi…", sub: "Nyalakan GPS & izinkan akses lokasi", dot: "wait" as const, tone: "amber" as const } };
  const near = sites.map((s) => ({ s, d: distanceMeters(fix, { lat: s.latitude, lng: s.longitude }) })).sort((a, b) => a.d - b.d)[0];
  const g = checkGeofence({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }, sites);
  const acc = `akurasi ±${Math.round(fix.accuracy)} m`;
  if (g.ok) return { fix, retry, ok: true, card: { title: near.s.name, sub: `Di dalam area · ${Math.round(near.d)} m dari titik · ${acc}`, dot: "ok" as const, tone: "emerald" as const } };
  const weak = fix.accuracy > MAX_GPS_ACCURACY;
  return { fix, retry, ok: false, card: { title: near.s.name, sub: weak ? `Sinyal GPS lemah (${acc}). Coba di area terbuka.` : `Di luar area · ${Math.round(near.d)} m dari titik (batas ${near.s.radiusM} m)`, dot: "bad" as const, tone: "rose" as const } };
}

function BigSubmit({ children, tone, disabled }: { children: React.ReactNode; tone: "emerald" | "brand"; disabled: boolean }) {
  const { pending } = useFormStatus();
  const cls = tone === "emerald" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-brand-600 hover:bg-brand-700";
  return (
    <button type="submit" disabled={pending || disabled} className={`flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-lg font-bold text-white shadow-lg transition active:scale-[0.99] disabled:opacity-60 ${cls}`}>
      {pending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {pending ? "Mencatat…" : children}
    </button>
  );
}

export type TodayProps = {
  name: string;
  photoUrl: string | null;
  shift: Shift | null;
  sites: Site[];
  att: { status: string; checkIn: string | null; checkOut: string | null; lateMinutes: number; note: string | null } | null;
  report: { division: string; sent: boolean } | null;
  checkIn: Action;
  checkOut: Action;
};

/** Absen hari ini (varian A): jam berjalan, foto profil, shift, status GPS, tombol besar Masuk / Pulang */
export function AbsenToday({ name, photoUrl, shift, sites, att, report, checkIn, checkOut }: TodayProps) {
  const now = useNow();
  const done = !!att?.checkOut;
  const inside = !!att?.checkIn && !done;
  const leave = att && !att.checkIn && (att.status === "IZIN" || att.status === "SAKIT" || att.status === "LIBUR") ? att.status : null;
  const loc = useLocation(leave || done ? [] : sites, !leave && !done);
  const title = leave ? "Absensi hari ini" : done ? "Sudah absen pulang" : inside ? "Absen Pulang" : "Absensi Masuk";
  const lateBadge = att?.checkIn ? (att.lateMinutes > 0 && att.status === "TERLAMBAT" ? <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">Telat {att.lateMinutes} mnt</span> : <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Tepat waktu</span>) : null;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h2 className="text-3xl font-extrabold tracking-tight text-brand-700">{title}</h2>
        <p className="text-sm text-slate-500">Informasi absensi Anda hari ini</p>
      </div>
      <div className="card px-4 py-5 text-center">
        <div className="text-5xl font-extrabold tabular-nums tracking-tight text-slate-900 sm:text-6xl" suppressHydrationWarning>{now ? fmtClock(now) : "--:--:--"}</div>
        <div className="mt-1 text-sm text-slate-500" suppressHydrationWarning>{now ? fmtLong(now) : " "}</div>
      </div>

      {!att?.checkIn && (
        <div className="flex flex-col items-center gap-2 py-1">
          <Avatar name={name} src={photoUrl} size={120} className="ring-4 ring-brand-100" />
          <div className="text-sm font-semibold text-slate-700">{name}</div>
          {!photoUrl && <Link href="/profil?isi=foto" className="text-xs font-medium text-brand-600 hover:underline">+ Pasang foto profil</Link>}
        </div>
      )}

      {leave ? (
        <div className="card p-4 text-center">
          <div className="text-lg font-bold text-slate-900">Hari ini tercatat {leave === "IZIN" ? "Izin" : leave === "SAKIT" ? "Sakit" : "Libur"}</div>
          {att?.note && <p className="mt-1 text-sm text-slate-500">{att.note}</p>}
          <p className="mt-2 text-xs text-slate-500">Bila ternyata masuk kerja, minta Supervisor mengubah absensi Anda.</p>
        </div>
      ) : att?.checkIn ? (
        <div className="grid grid-cols-2 gap-3 keep-cols">
          <div className="card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Masuk</div>
            <div className="text-2xl font-extrabold tabular-nums text-slate-900">{fmtHm(att.checkIn)}</div>
            <div className="mt-1">{lateBadge}</div>
          </div>
          <div className="card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{done ? "Pulang" : "Lama kerja"}</div>
            <div className="text-2xl font-extrabold tabular-nums text-slate-900" suppressHydrationWarning>{done ? fmtHm(att.checkOut!) : now ? duration(att.checkIn, now) : "—"}</div>
            <div className="mt-1 text-xs text-slate-500">{done ? `Lama kerja ${duration(att.checkIn, new Date(att.checkOut!))}` : shift ? `shift s/d ${shift.endTime}` : ""}</div>
          </div>
        </div>
      ) : shift ? (
        <InfoCard icon={CLOCK} tone="brand" eyebrow="Shift hari ini" title={`${shift.name} · ${shift.startTime} – ${shift.endTime}`} sub={`Toleransi telat ${shift.toleranceMinutes} menit (sampai ${addMin(shift.startTime, shift.toleranceMinutes)})`} />
      ) : null}

      {inside && report && !report.sent && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex gap-3 text-amber-800">
            <Icon d={WARN} className="mt-0.5 shrink-0" />
            <div className="text-sm"><b>Laporan shift {report.division} hari ini belum dikirim.</b><br />Absen pulang tetap bisa, tapi kirim laporan dulu supaya PIC tidak diingatkan.</div>
          </div>
          <Link href="/laporan" className="btn-primary mt-3 w-full">+ Lapor sekarang</Link>
        </div>
      )}

      {!leave && !done && sites.length > 0 && <InfoCard icon={PIN} tone={loc.card.tone} eyebrow="Lokasi absen" title={loc.card.title} sub={loc.card.sub} dot={loc.card.dot} />}
      {!leave && !done && "error" in loc && loc.error && <button type="button" className="btn-secondary w-full" onClick={loc.retry}>Coba baca GPS lagi</button>}

      {!leave && !done && (
        <ActionForm action={inside ? checkOut : checkIn}>
          <input type="hidden" name="lat" value={loc.fix?.lat ?? ""} />
          <input type="hidden" name="lng" value={loc.fix?.lng ?? ""} />
          <input type="hidden" name="accuracy" value={loc.fix?.accuracy ?? ""} />
          <BigSubmit tone={inside ? "brand" : "emerald"} disabled={sites.length > 0 && !loc.fix}>{inside ? "Absen Pulang" : "Absen Masuk"}</BigSubmit>
        </ActionForm>
      )}
      {done && <div className="rounded-2xl bg-emerald-50 p-4 text-center text-sm font-semibold text-emerald-700">✓ Absensi hari ini lengkap. Terima kasih, hati-hati di jalan!</div>}
    </div>
  );
}
