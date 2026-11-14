// Buat gambar & PDF Lembar Panduan dari halaman cetak ERP (/cetak/panduan) — sumber sama dengan halaman Panduan.
// Pakai (ERP berjalan, akun Owner):  U=<username> P=<password> node scripts/panduan-jpg.cjs [folder] [id,id,...]
//   → <folder>/panduan-<id>.png (2480 × 3508, A4 300 dpi), panduan-<id>.pdf (A4, teks vektor), panduan-semua.pdf
// Jangan simpan password di file.
const { chromium } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.argv[2] || "docs/panduan";
const IDS = (process.argv[3] || "cetak,produksi,giftbox,packing,assembling,supervisor,finance,owner").split(",");
if (!process.env.U || !process.env.P) { console.error("Isi U dan P (akun ERP Owner) lewat environment"); process.exit(1); }
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(BASE + "/login", { timeout: 180000 });
  await p.fill('input[name="username"]', process.env.U); await p.fill('input[name="password"]', process.env.P);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180000 }), p.click('button[type="submit"]')]);
  let bad = 0;
  for (const id of IDS) {
    await p.goto(`${BASE}/cetak/panduan?g=${id}`, { waitUntil: "networkidle", timeout: 180000 });
    // PDF: A4, latar ikut, margin 0, ukuran dari CSS @page; teks tetap vektor
    if (!process.env.NO_PDF) await p.pdf({ path: `${OUT}/panduan-${id}.pdf`, format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
    // Gambar: lembar ukuran asli 1240 px × 2 = 2480 px
    await p.addStyleTag({ content: ".cetak-page{width:auto!important;height:auto!important;margin:0!important;box-shadow:none!important;zoom:1!important}.cetak-page>.panduan{zoom:1!important}.no-print,nextjs-portal{display:none!important}" });
    const el = p.locator(`#panduan-${id}`);
    const h = await el.evaluate((e) => { e.classList.add("exporting"); return e.scrollHeight; });
    if (h > 1754) bad++;
    console.log(id, "tinggi", h, h > 1754 ? "MELEBIHI A4" : "ok");
    fs.writeFileSync(`${OUT}/panduan-${id}.png`, await el.screenshot({ type: "png" }));
  }
  if (!process.env.NO_PDF && IDS.length > 1) {
    await p.goto(`${BASE}/cetak/panduan?g=semua`, { waitUntil: "networkidle", timeout: 180000 });
    await p.pdf({ path: `${OUT}/panduan-semua.pdf`, format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
  }
  await b.close();
  process.exit(bad ? 2 : 0);
})();
