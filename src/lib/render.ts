import { SignJWT } from "jose";
import type { Browser } from "playwright-core";

/**
 * Membuat JPG dokumen ber-kop (DocSheet) di server, untuk dikirim lewat bot Telegram.
 * Chromium headless membuka halaman ERP yang sama dengan sesi singkat milik pengguna Telegram tersebut,
 * sehingga hak akses tetap diperiksa oleh halaman itu sendiri, lalu dokumennya digambar persis seperti tombol "Unduh JPG".
 *
 * Kebutuhan di server: `npx playwright-core install chromium` (sekali), atau CHROMIUM_PATH ke Chromium/Chrome yang sudah ada.
 */

export class RenderError extends Error {}

let browser: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowser() {
  if (!browser) {
    browser = import("playwright-core").then(({ chromium }) =>
      chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] }),
    );
    browser.catch(() => (browser = null));
  }
  return browser;
}

/** Tutup Chromium bila 3 menit tidak dipakai agar RAM VPS tidak tersita */
function scheduleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const b = browser;
    browser = null;
    await (await b?.catch(() => null))?.close().catch(() => {});
  }, 180_000);
  idleTimer.unref?.();
}

function baseUrl() {
  return (process.env.INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

async function shortSession(userId: string) {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new RenderError("AUTH_SECRET belum diatur");
  return new SignJWT({ sub: userId, via: "telegram" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(s));
}

/** Render elemen DocSheet `targetId` di halaman `path` (mis. /akuntansi/arus-kas?from=…) menjadi JPG */
export async function renderDocJpg(userId: string, path: string, targetId: string): Promise<Buffer> {
  let b: Browser;
  try {
    b = await getBrowser();
  } catch (e) {
    throw new RenderError(`Chromium belum terpasang di server (${(e as Error).message.split("\n")[0].slice(0, 120)})`);
  }
  const base = baseUrl();
  const ctx = await b.newContext({ deviceScaleFactor: 2, viewport: { width: 1100, height: 900 }, colorScheme: "light" });
  try {
    const { hostname } = new URL(base);
    await ctx.addCookies([{ name: "mg_session", value: await shortSession(userId), domain: hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    const res = await page.goto(base + path, { waitUntil: "networkidle", timeout: 45_000 });
    if (!res || res.status() >= 400 || /\/(login|forbidden)/.test(new URL(page.url()).pathname)) throw new RenderError("Dokumen tidak ditemukan atau Anda tidak berwenang");
    const found = await page.locator(`#${targetId}`).count();
    if (!found) throw new RenderError("Dokumen tidak ditemukan atau Anda tidak berwenang");
    // Sama dengan DownloadJpg: salin dokumen ke wadah selebar data-export-width, versi terang, semua baris tampil
    await page.evaluate(async (id) => {
      const el = document.getElementById(id)!;
      const width = Number(el.dataset.exportWidth) || 1000;
      const host = document.createElement("div");
      host.id = "__tg_export";
      host.style.cssText = `position:absolute;left:0;top:0;width:${width}px;background:#fff;z-index:2147483647`;
      const node = el.cloneNode(true) as HTMLElement;
      node.removeAttribute("id");
      node.classList.add("theme-light", "exporting");
      node.style.width = `${width}px`;
      host.appendChild(node);
      document.body.appendChild(host);
      await Promise.all([...node.querySelectorAll("img")].map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : img.decode().catch(() => {}))));
    }, targetId);
    return await page.locator("#__tg_export").screenshot({ type: "jpeg", quality: 92, timeout: 30_000 });
  } finally {
    await ctx.close().catch(() => {});
    scheduleClose();
  }
}
