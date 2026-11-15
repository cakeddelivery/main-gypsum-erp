// Audit tampilan HP: buka halaman-halaman utama di layar 360×740 dan 320×640, cari
//  (1) halaman melebar ke samping (scroll horizontal halaman),
//  (2) elemen yang keluar dari layar tanpa wadah gulir,
//  (3) teks terpotong (…/line-clamp) yang isinya tidak muat.
// Popup form laporan shift (semua langkah) ikut diperiksa.
//
// Pakai (ERP berjalan; sebaiknya setelah `npx tsx scripts/data-uji-teks-panjang.ts`):
//   U=<username> P=<password> [BASE=http://localhost:3000] [SHOTS=folder] node scripts/cek-tampilan-hp.cjs [/halaman ...]
// Keluar dengan kode 1 bila ada temuan (bisa dipakai di CI / sebelum rilis).
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3000";
const SHOTS = process.env.SHOTS || "";
if (!process.env.U || !process.env.P) { console.error("Isi U dan P (akun ERP) lewat environment"); process.exit(2); }

const DEFAULT_PAGES = [
  "/", "/absensi", "/absensi?tab=riwayat", "/absensi?tab=izin", "/absensi?tab=harian", "/absensi?tab=jadwal", "/absensi?tab=validasi",
  "/laporan", "/laporan/rekap", "/laporan/monitoring", "/laporan/order", "/laporan/bahan",
  "/stok", "/stok/master", "/stok/permintaan", "/stok/pembelian", "/stok/mutasi", "/stok/opname", "/stok/kartu",
  "/produk", "/produk/induk", "/produk/setengah-jadi", "/produk/laba", "/produksi", "/penjualan",
  "/retur", "/retur/komplain", "/supplier", "/pelanggan", "/borongan", "/borongan?tab=terima",
  "/karyawan", "/karyawan/pendaftaran", "/gaji", "/gaji/saya", "/gaji/kasbon", "/finance", "/finance/mutasi", "/finance/talangan",
  "/akuntansi", "/akuntansi/jurnal", "/akuntansi/buku-besar", "/akuntansi/arus-kas", "/akuntansi/laba-rugi", "/akuntansi/neraca", "/akuntansi/piutang-utang",
  "/analitik", "/pengaturan", "/pengaturan/pengguna", "/profil", "/panduan",
];
const SIZES = [[360, 740], [320, 640]];

/** Dijalankan di halaman: kumpulkan temuan overflow / teks terpotong di dalam `root` */
function audit(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return [];
  const W = window.innerWidth;
  const out = [];
  const name = (el) => {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60);
    return `<${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 3).join(".") : ""}> "${t}"`;
  };
  const scrollerX = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      if (ox === "hidden" || ox === "clip") return "clip";
    }
    return false;
  };
  if (!rootSel && document.documentElement.scrollWidth > W + 1) out.push(`Halaman melebar: ${document.documentElement.scrollWidth}px > layar ${W}px`);
  for (const el of root.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (el.closest("[data-pg-hidden], .sr-only, .choice-native, [aria-hidden=true], video, svg, canvas")) continue;
    // Teks terpotong: ellipsis yang benar-benar memotong / line-clamp yang kepanjangan
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !el.closest("nav, header, .no-audit")) out.push(`Teks terpotong (…): ${name(el)}`);
    if (hasText && cs.webkitLineClamp && cs.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 2) out.push(`Teks terpotong (baris): ${name(el)}`);
    // Keluar layar ke kanan tanpa wadah gulir
    if (r.right > W + 1 && r.left < W && hasText) {
      const s = scrollerX(el);
      if (!s) out.push(`Keluar layar (${Math.round(r.right)}px > ${W}px): ${name(el)}`);
    }
  }
  return [...new Set(out)];
}

(async () => {
  const pages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES;
  const b = await chromium.launch();
  let total = 0;
  const report = [];
  for (const [w, h] of SIZES) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { try { localStorage.setItem("mg_lengkapi_akun", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })); } catch {} });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`);
    await p.fill('input[name="username"]', process.env.U);
    await p.fill('input[name="password"]', process.env.P);
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), p.click('button[type="submit"]')]);
    const check = async (label, rootSel) => {
      const found = await p.evaluate(audit, rootSel ?? null);
      total += found.length;
      report.push(`${found.length ? "✗" : "✓"} ${w}×${h} ${label}${found.length ? "\n    " + found.join("\n    ") : ""}`);
      if (SHOTS && found.length) await p.screenshot({ path: `${SHOTS}/${w}-${label.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: !rootSel });
    };
    for (const path of pages) {
      const res = await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 120000 }).catch(() => null);
      if (!res || res.status() >= 400 || p.url().includes("/forbidden")) { report.push(`- ${w}×${h} ${path} dilewati (tidak ada akses)`); continue; }
      await p.waitForTimeout(400);
      await check(path);
    }
    // Popup laporan shift: laporan di REPORTS (id dipisah koma) atau laporan pertama di daftar; periksa setiap langkah
    let ids = (process.env.REPORTS || "").split(",").filter(Boolean);
    if (!ids.length) {
      await p.goto(`${BASE}/laporan`, { waitUntil: "networkidle" });
      const href = await p.locator('a[href^="/laporan/c"]').first().getAttribute("href").catch(() => null);
      if (href) ids = [href.split("/")[2].split("?")[0]];
    }
    for (const id of ids) {
      await p.goto(`${BASE}/laporan/${id}`, { waitUntil: "networkidle" });
      const open = p.getByRole("button", { name: /Lanjutkan isi laporan|Ubah laporan/ });
      if (await open.count()) {
        await open.click();
        const steps = p.locator('dialog[open] nav[aria-label="Langkah laporan"] button');
        const n = await steps.count();
        for (let i = 0; i < n; i++) {
          await steps.nth(i).click();
          await p.locator("dialog[open] details:not([open]) summary").evaluateAll((els) => els.forEach((e) => e.click()));
          await p.waitForTimeout(300);
          await check(`popup laporan ${id.slice(-4)} › ${(await steps.nth(i).innerText()).replace(/\s+/g, " ").trim()}`, "dialog[open]");
          if (SHOTS && process.env.SHOT_STEP && (await steps.nth(i).innerText()).includes(process.env.SHOT_STEP)) await p.screenshot({ path: `${SHOTS}/${w}-langkah-${process.env.SHOT_STEP.replace(/\s+/g, "_")}.png` });
        }
      }
    }
    await ctx.close();
  }
  await b.close();
  console.log(report.join("\n"));
  console.log(total ? `\n${total} temuan` : "\nTidak ada temuan");
  if (SHOTS) fs.writeFileSync(`${SHOTS}/laporan-audit.txt`, report.join("\n"));
  process.exit(total ? 1 : 0);
})();
