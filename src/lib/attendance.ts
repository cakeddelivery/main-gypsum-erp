import type { AttendanceStatus } from "@prisma/client";
import { jakartaParts, toMinutes } from "./time";

/** Hitung keterlambatan berdasarkan jam mulai shift + toleransi (zona WIB). */
export function evaluateCheckIn(shift: { startTime: string; toleranceMinutes: number }, checkIn: Date): { status: AttendanceStatus; lateMinutes: number } {
  const p = jakartaParts(checkIn);
  const minutes = p.hour * 60 + p.minute;
  const late = Math.max(0, minutes - toMinutes(shift.startTime));
  if (late > shift.toleranceMinutes) return { status: "TERLAMBAT", lateMinutes: late };
  return { status: "HADIR", lateMinutes: late };
}

/** Tentukan shift otomatis: jam mulai yang paling dekat dengan jam absen (WIB, memperhitungkan lewat tengah malam). */
export function nearestShift<T extends { startTime: string }>(shifts: T[], at: Date): T | null {
  const p = jakartaParts(at);
  const now = p.hour * 60 + p.minute;
  let best: { s: T; gap: number } | null = null;
  for (const s of shifts) {
    const d = Math.abs(now - toMinutes(s.startTime));
    const gap = Math.min(d, 1440 - d);
    if (!best || gap < best.gap) best = { s, gap };
  }
  return best?.s ?? null;
}

export const ATT_LABEL: Record<AttendanceStatus, string> = {
  HADIR: "Hadir",
  TERLAMBAT: "Terlambat",
  IZIN: "Izin",
  SAKIT: "Sakit",
  ALPA: "Alpa",
  LIBUR: "Libur",
};

/** Jarak dua titik GPS dalam meter (rumus haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Akurasi GPS terburuk yang masih diterima saat absen (meter) */
export const MAX_GPS_ACCURACY = 150;

export type GeoPoint = { lat: number; lng: number; accuracy: number | null };
type Site = { id: string; name: string; latitude: number; longitude: number; radiusM: number };
export type GeofenceResult = { ok: true; site: Site | null; distance: number | null } | { ok: false; error: string };

/**
 * Cek apakah posisi karyawan berada di dalam radius salah satu titik lokasi kerja aktif.
 * Bila belum ada titik lokasi sama sekali, absen tetap diizinkan (lokasi hanya dicatat).
 */
export function checkGeofence(pos: GeoPoint | null, sites: Site[]): GeofenceResult {
  if (!sites.length) return { ok: true, site: null, distance: null };
  if (!pos) return { ok: false, error: "Lokasi GPS tidak terbaca. Izinkan akses lokasi di browser lalu coba lagi." };
  if (pos.accuracy != null && pos.accuracy > MAX_GPS_ACCURACY)
    return { ok: false, error: `Sinyal GPS kurang akurat (±${Math.round(pos.accuracy)} m). Nyalakan GPS/mode akurasi tinggi lalu coba lagi.` };
  let best: { site: Site; distance: number } | null = null;
  for (const s of sites) {
    const d = distanceMeters(pos, { lat: s.latitude, lng: s.longitude });
    if (!best || d - s.radiusM < best.distance - best.site.radiusM) best = { site: s, distance: d };
  }
  if (best && best.distance <= best.site.radiusM) return { ok: true, site: best.site, distance: Math.round(best.distance) };
  return { ok: false, error: `Anda di luar lokasi kerja (${Math.round(best!.distance)} m dari ${best!.site.name}, batas ${best!.site.radiusM} m).` };
}

/** Baca koordinat dari FormData (diisi otomatis oleh tombol absen di browser). */
export function readGeo(fd: FormData): GeoPoint | null {
  const n = (k: string) => {
    const v = fd.get(k);
    if (typeof v !== "string" || v.trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const lat = n("lat");
  const lng = n("lng");
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, accuracy: n("accuracy") };
}
