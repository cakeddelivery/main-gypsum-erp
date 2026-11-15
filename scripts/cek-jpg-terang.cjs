// Cek: setiap ekspor JPG (tombol "Unduh JPG") berlatar putih walau HP & aplikasi mode gelap, dan layar kembali gelap.
// Pakai (ERP berjalan, akun owner bawaan data uji): node scripts/cek-jpg-terang.cjs http://localhost:3000 /laporan/<id> /panduan /akuntansi/neraca …
// Keluar dengan kode 1 bila ada JPG yang tidak terang.
const { chromium } = require("playwright");
const [base, ...paths] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, colorScheme: "dark" });
  await ctx.addInitScript(() => { try { localStorage.setItem("mg_lengkapi_akun", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })); } catch {} });
  const p = await ctx.newPage();
  await p.goto(`${base}/login`);
  await p.fill('input[name="username"]', "owner"); await p.fill('input[name="password"]', "Gypsum#2026");
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), p.click('button[type="submit"]')]);
  let bad = 0;
  for (const path of paths) {
    await p.goto(base + path, { waitUntil: "networkidle", timeout: 120000 });
    const theme = await p.evaluate(() => document.documentElement.dataset.theme);
    const btn = p.getByRole("button", { name: /Unduh JPG|Lihat & unduh JPG|JPG/ }).first();
    if (!(await btn.count())) { console.log("-", path, "tidak ada tombol JPG"); continue; }
    await btn.click();
    const img = p.locator("dialog[open] img[src^='data:image/jpeg']").first();
    await img.waitFor({ timeout: 60000 });
    const res = await img.evaluate(async (el) => {
      const c = document.createElement("canvas"); c.width = el.naturalWidth; c.height = el.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(el, 0, 0);
      const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
      // sudut + titik di tengah kiri (latar dokumen) ; hitung rata-rata kecerahan seluruh gambar
      const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 4 * 97) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return { corner: px(5, 5), mid: px(10, Math.floor(c.height / 2)), avg: Math.round(sum / (d.length / (4 * 97))) };
    });
    const ok = res.corner.every((v) => v > 245) && res.mid.every((v) => v > 230) && res.avg > 200;
    if (!ok) bad++;
    console.log(ok ? "✓" : "✗", path, "tema layar:", theme, JSON.stringify(res));
    console.log("   tema layar setelah ekspor:", await p.evaluate(() => document.documentElement.dataset.theme));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
  }
  await b.close();
  process.exit(bad ? 1 : 0);
})();
