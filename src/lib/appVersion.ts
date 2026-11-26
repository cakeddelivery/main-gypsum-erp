/**
 * Versi build aplikasi untuk pembaruan otomatis PWA.
 * APP_BUILD_ID ditanam saat `next build` (lihat next.config.mjs), jadi kode yang sedang berjalan di HP
 * tahu versinya sendiri; /api/version memberi versi server yang sedang aktif.
 */
export const CURRENT_BUILD = process.env.APP_BUILD_ID || "dev";

/** Server menjalankan build lain dari yang sedang terbuka di HP */
export function isNewBuild(current: string, server: unknown): boolean {
  return typeof server === "string" && server !== "" && server !== "dev" && current !== "dev" && server !== current;
}

const STALE = [
  /ChunkLoadError/i,
  /Loading (CSS )?chunk [\w./-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /failed-to-find-server-action/i,
  /Failed to find Server Action/i,
  /Server Action "[^"]*" was not found on the server/i,
  /UnrecognizedActionError/i,
  /Server Reference ID/i,
  /did not match the expected format/i,
  /An unexpected response was received from the server/i,
];

/** Error karena HP masih menjalankan versi lama setelah deploy (file JS lama hilang / server action berganti) */
export function isStaleError(e: unknown): boolean {
  if (!e) return false;
  const text = typeof e === "string" ? e : e instanceof Error ? `${e.name} ${e.message}` : typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";
  return STALE.some((re) => re.test(text));
}

export const RELOAD_KEY = "mg-auto-reload";
/** Muat ulang otomatis paling sering sekali per menit: mencegah muat ulang berulang tanpa henti */
export const RELOAD_GAP_MS = 60_000;

/** Boleh muat ulang otomatis bila muat ulang otomatis terakhir sudah lewat RELOAD_GAP_MS */
export function canAutoReload(lastStamp: string | null, now: number): boolean {
  const last = Number(lastStamp);
  return !lastStamp || !Number.isFinite(last) || now - last > RELOAD_GAP_MS || last > now;
}

/** Ada isian form yang berubah dari nilai awalnya (draf yang belum disimpan) */
export function formDirty(form: HTMLFormElement): boolean {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (["hidden", "submit", "button", "reset", "image"].includes(el.type)) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked !== el.defaultChecked) return true;
      } else if (el.type === "file") {
        if (el.files && el.files.length > 0) return true;
      } else if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      if (Array.from(el.options).some((o) => o.selected !== o.defaultSelected)) return true;
    }
  }
  return false;
}

/**
 * Pengguna sedang mengisi sesuatu: popup terbuka, kolom sedang diketik, atau ada form yang sudah diubah.
 * Popup pemberitahuan tanpa isian (pengingat, pratinjau) ditandai data-update-safe agar tidak menahan pembaruan.
 */
/** Tandai unggahan sedang berjalan (mis. foto checklist): pembaruan otomatis menunggu sampai selesai */
export function setUploading(on: boolean, doc: Document = document) {
  const el = doc.documentElement;
  const n = Number(el.dataset.uploading || 0) + (on ? 1 : -1);
  if (n > 0) el.dataset.uploading = String(n);
  else delete el.dataset.uploading;
}

export function isBusy(doc: Document): boolean {
  if (doc.documentElement?.dataset?.uploading) return true;
  if (doc.querySelector("dialog[open]:not([data-update-safe])")) return true;
  const a = doc.activeElement as HTMLElement | null;
  if (a && (a.isContentEditable || ((a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT") && !(a as HTMLInputElement).readOnly))) return true;
  return Array.from(doc.forms).some(formDirty);
}

export const STALE_EVENT = "mg-stale-error";
export const STALE_MESSAGE = "Aplikasi diperbarui, memuat ulang…";

/** Server sedang menjalankan build lain dari yang terbuka di HP (dicek lewat /api/version; gagal jaringan = dianggap tidak beda) */
export async function serverBuildDiffers(): Promise<boolean> {
  try {
    const res = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: string };
    return isNewBuild(CURRENT_BUILD, build);
  } catch {
    return false;
  }
}

/**
 * Jalankan server action; bila gagal karena klien basi setelah deploy (action tidak dikenal / respons aneh / versi build beda)
 * picu pemuatan ulang otomatis (sekali per menit, lihat AppUpdater) dan kembalikan pesan ramah. Error lain dilempar ulang.
 */
export async function runActionGuarded<T extends { ok: boolean; error?: string }>(run: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await run();
  } catch (e) {
    if (isStaleError(e) || (await serverBuildDiffers())) {
      if (typeof window !== "undefined") window.dispatchEvent(new Event(STALE_EVENT));
      return { ok: false, error: STALE_MESSAGE };
    }
    throw e;
  }
}
