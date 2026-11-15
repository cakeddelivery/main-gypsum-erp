/**
 * Ingat popup form yang sedang terbuka (per tab, sessionStorage) agar bisa dibuka lagi otomatis bila halaman
 * dimuat ulang di tengah pengisian (mis. HP RAM kecil menutup browser saat kamera/galeri dibuka).
 */
export const REOPEN_TTL_MS = 2 * 60 * 60 * 1000;
export type ReopenState = { t: number; step?: string; item?: number };

export function readReopen(key: string, now = Date.now()): ReopenState | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? "null") as ReopenState | null;
    if (!v || typeof v.t !== "number" || now - v.t > REOPEN_TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

export function writeReopen(key: string, patch: Partial<ReopenState>) {
  try {
    const cur = readReopen(key) ?? { t: Date.now() };
    sessionStorage.setItem(key, JSON.stringify({ ...cur, ...patch, t: Date.now() }));
  } catch {}
}

export function clearReopen(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

export const reportReopenKey = (id: string) => `mg_lapor_buka_${id}`;
