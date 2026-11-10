// Cek PWA (butuh build produksi yang berjalan: npm run build && npm start).
// node scripts/pwa-check.cjs   (BASE_URL, PW opsional; login memakai akun owner seed)
// Memeriksa: manifest layak instal, service worker aktif, cache hanya aset statis, halaman /offline saat offline,
// kartu "Pasang aplikasi" di Profil (tersembunyi saat standalone).
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "OK  " : "GAGAL"} ${msg}`); if (!ok) fails.push(msg); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login");
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  check(!!href, `link manifest ada (${href})`);
  check(!!(await page.getAttribute('link[rel="apple-touch-icon"]', "href")), "apple-touch-icon ada");
  check((await page.getAttribute('meta[name="viewport"]', "content"))?.includes("viewport-fit=cover"), "viewport-fit=cover");
  const m = await (await page.request.get(BASE + href)).json();
  check(m.name && m.short_name && m.start_url && m.display === "standalone", `manifest: ${m.name} / ${m.short_name} / ${m.start_url} / ${m.display}`);
  for (const size of ["192x192", "512x512"]) check(m.icons.some((i) => i.sizes === size), `ikon ${size}`);
  check(m.icons.some((i) => i.purpose === "maskable"), "ikon maskable");
  for (const i of m.icons) check((await page.request.get(BASE + i.src)).ok(), `ikon bisa diunduh tanpa login: ${i.src}`);

  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active?.scriptURL; });
  check(sw?.endsWith("/sw.js"), `service worker aktif (${sw})`);
  await page.reload();
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), "halaman dikendalikan service worker");

  await page.fill('input[name="username"]', "owner");
  await page.fill('input[name="password"]', process.env.PW || "Gypsum#2026");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), page.click('button[type="submit"]')]);
  await page.goto(BASE + "/profil");
  check(await page.getByRole("heading", { name: "Pasang aplikasi" }).isVisible(), "kartu Pasang aplikasi tampil di Profil");
  await page.goto(BASE + "/finance");
  const cached = await page.evaluate(async () => { const a = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) a.push(new URL(r.url).pathname); return a; });
  const bad = cached.filter((p) => !p.startsWith("/_next/static/") && !p.startsWith("/pwa/") && p !== "/offline");
  check(bad.length === 0, `cache tidak berisi halaman/data ERP ${bad.length ? JSON.stringify(bad) : ""}`);

  await ctx.setOffline(true);
  await page.goto(BASE + "/stok").catch(() => {});
  check((await page.locator("h1").first().textContent()) === "Sedang offline", "saat offline tampil halaman Sedang offline");
  check(await page.getByRole("button", { name: "Coba lagi" }).isVisible(), "tombol Coba lagi ada");
  await Promise.all([page.waitForEvent("load"), ctx.setOffline(false)]);
  check(page.url().endsWith("/stok") && (await page.title()).startsWith("Stok"), "kembali online: halaman termuat lagi otomatis");

  const p2 = await ctx.newPage();
  await p2.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
  await p2.goto(BASE + "/profil");
  await p2.waitForTimeout(500);
  check((await p2.getByRole("heading", { name: "Pasang aplikasi" }).count()) === 0, "kartu disembunyikan saat aplikasi terpasang");

  await browser.close();
  console.log(fails.length ? `\n${fails.length} cek GAGAL` : "\nSemua cek PWA OK");
  process.exit(fails.length ? 1 : 0);
})();
