"use client";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

type Fix = { lat: number; lng: number; accuracy: number };

function geoError(e: GeolocationPositionError): string {
  if (e.code === e.PERMISSION_DENIED) return "Akses lokasi ditolak. Izinkan lokasi untuk situs ini di pengaturan browser, lalu muat ulang halaman.";
  if (e.code === e.TIMEOUT) return "GPS belum dapat sinyal. Coba di area terbuka lalu tekan Coba lagi.";
  return "Lokasi tidak bisa dibaca. Pastikan GPS HP menyala.";
}

/** Pantau posisi GPS HP selama halaman terbuka */
function useGeo() {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setError("Browser ini tidak mendukung GPS.");
      return;
    }
    setError(null);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        setError(null);
      },
      (e) => setError(geoError(e)),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [attempt]);
  return { fix, error, retry: () => setAttempt((n) => n + 1) };
}

/**
 * Isi koordinat GPS ke form absen (lat, lng, accuracy) + tombol kirim.
 * Bila `required`, tombol baru aktif setelah lokasi terbaca. Server tetap memeriksa ulang radiusnya.
 */
export function GeoSubmit({ required, children, className = "btn-primary", pendingText = "Mencatat…" }: { required: boolean; children: React.ReactNode; className?: string; pendingText?: string }) {
  const { fix, error, retry } = useGeo();
  const { pending } = useFormStatus();
  const waiting = required && !fix;
  return (
    <div className="flex flex-col gap-1.5">
      <input type="hidden" name="lat" value={fix?.lat ?? ""} />
      <input type="hidden" name="lng" value={fix?.lng ?? ""} />
      <input type="hidden" name="accuracy" value={fix?.accuracy ?? ""} />
      <button type="submit" className={className} disabled={pending || waiting}>
        {pending ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {pendingText}
          </>
        ) : waiting && !error ? (
          "Membaca lokasi GPS…"
        ) : (
          children
        )}
      </button>
      {fix && <span className="text-xs text-slate-500">📍 Lokasi terbaca (akurasi ±{Math.round(fix.accuracy)} m)</span>}
      {error && (
        <span className="text-xs text-rose-600">
          {error}{" "}
          <button type="button" className="underline" onClick={retry}>Coba lagi</button>
        </span>
      )}
    </div>
  );
}

/** Tombol untuk mengisi input latitude/longitude di form dengan posisi HP saat ini */
export function UseMyLocation() {
  const ref = useRef<HTMLButtonElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = () => {
    const form = ref.current?.form;
    if (!form || !("geolocation" in navigator)) return setMsg("Browser ini tidak mendukung GPS.");
    setBusy(true);
    setMsg(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        (form.elements.namedItem("latitude") as HTMLInputElement).value = p.coords.latitude.toFixed(6);
        (form.elements.namedItem("longitude") as HTMLInputElement).value = p.coords.longitude.toFixed(6);
        setMsg(`Terisi dari posisi Anda (akurasi ±${Math.round(p.coords.accuracy)} m)`);
        setBusy(false);
      },
      (e) => {
        setMsg(geoError(e));
        setBusy(false);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  };
  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2">
      <button ref={ref} type="button" className="btn-secondary btn-sm" onClick={pick} disabled={busy}>
        {busy ? "Membaca GPS…" : "📍 Pakai lokasi saya sekarang"}
      </button>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
