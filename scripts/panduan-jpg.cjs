// Render Lembar Panduan per divisi (halaman /profil/panduan) ke gambar A4 300 dpi (2480 × 3508).
// Pakai: jalankan ERP (npm run dev / start), lalu
//   U=<username> P=<password> node scripts/panduan-jpg.cjs [folder-keluaran] [cetak,produksi,...]
// Hasil PNG; ubah ke JPG (mis. dengan sharp/ImageMagick) bila perlu. Jangan simpan password di file.
const { chromium } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.argv[2] || "docs/panduan";
const kinds = (process.argv[3] || "cetak,produksi,giftbox,packing,assembling").split(",");
if (!process.env.U || !process.env.P) { console.error("Isi U dan P (akun ERP) lewat environment"); process.exit(1); }
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 2 })).newPage();
  await p.goto(BASE + "/login", { timeout: 180000 });
  await p.fill('input[name="username"]', process.env.U); await p.fill('input[name="password"]', process.env.P);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180000 }), p.click('button[type="submit"]')]);
  for (const k of kinds) {
    await p.goto(`${BASE}/profil/panduan?divisi=${k}`, { waitUntil: "networkidle", timeout: 180000 });
    const nb = p.getByRole("button", { name: "Nanti saja" }); if (await nb.isVisible().catch(() => false)) { await nb.click(); await p.waitForTimeout(400); }
    // Sembunyikan header/menu aplikasi agar tidak menutupi lembar saat difoto
    await p.addStyleTag({ content: "header:not(.doc-kop), nav, aside, .no-print, nextjs-portal { display: none !important; }" });
    const el = p.locator("#panduan-sheet");
    const h = await el.evaluate((e) => { e.classList.add("exporting"); return e.scrollHeight; });
    console.log(k, "tinggi", h, h > 1754 ? "MELEBIHI A4" : "ok");
    const png = await el.screenshot({ type: "png" });
    fs.writeFileSync(`${OUT}/panduan-${k}.png`, png);
  }
  await b.close();
})();
