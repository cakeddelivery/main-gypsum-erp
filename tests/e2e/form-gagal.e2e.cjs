/**
 * Uji Playwright (layar HP 360px): form yang gagal disimpan TIDAK boleh mengosongkan isian,
 * kolom yang salah ditandai merah, lalu difokus — termasuk kolom di langkah lain pada popup bertahap.
 *
 * Jalankan dengan server dev/staging menyala:
 *   E2E_URL=http://localhost:3000 E2E_USER=<username owner> E2E_PASS=<password> node tests/e2e/form-gagal.e2e.cjs
 * (kata sandi diambil dari variabel lingkungan, tidak ditulis di repo)
 */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const URL = process.env.E2E_URL || "http://localhost:3000";
const { E2E_USER, E2E_PASS } = process.env;
if (!E2E_USER || !E2E_PASS) {
  console.error("Isi E2E_USER dan E2E_PASS");
  process.exit(2);
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 360, height: 760 } });
  await p.goto(`${URL}/login`);
  await p.fill("input[name=username]", E2E_USER);
  await p.fill("input[name=password]", E2E_PASS);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 }), p.click("button[type=submit]")]);
  const noPopup = () => p.evaluate(() => document.querySelectorAll('dialog[aria-labelledby="lengkapi-akun"]').forEach((d) => d.remove()));

  // 1) Ditolak server: karyawan bulanan tanpa tanggal masuk
  await p.goto(`${URL}/karyawan`, { waitUntil: "networkidle", timeout: 120000 });
  await noPopup();
  await p.click("text=+ Karyawan");
  const d = p.locator("dialog[open]").last();
  await d.locator("input[name=name]").fill("Uji Form Gagal");
  await d.locator("input[name=phone]").fill("081299990000");
  await d.locator("select[name=wageType]").selectOption("BULANAN", { force: true });
  await d.locator("input[name=monthlySalary]").fill("3000000");
  await d.locator("button[type=submit]").click();
  await p.waitForSelector("dialog[open] [name=joinDate][aria-invalid=true]", { timeout: 20000 });
  const k = await p.evaluate(() => {
    const dl = [...document.querySelectorAll("dialog[open]")].pop();
    return { name: dl.querySelector("[name=name]").value, phone: dl.querySelector("[name=phone]").value, sal: dl.querySelector("[name=monthlySalary]").value, wage: dl.querySelector("[name=wageType]").value, focus: document.activeElement?.getAttribute("name") };
  });
  assert.deepEqual(k, { name: "Uji Form Gagal", phone: "081299990000", sal: "3000000", wage: "BULANAN", focus: "joinDate" });
  console.log("✓ karyawan: isian tetap, fokus ke Tanggal masuk");

  // 2) Popup bertahap (laporan shift): kolom wajib kosong di langkah 1 saat berada di langkah terakhir
  await p.goto(`${URL}/laporan`, { waitUntil: "networkidle", timeout: 120000 });
  await noPopup();
  const draft = await p.$$eval("a[href^='/laporan/c']", (as) => as.map((a) => a.getAttribute("href"))[0]);
  if (!draft) {
    console.log("- laporan: tidak ada laporan untuk diuji, dilewati");
  } else {
    await p.goto(`${URL}${draft}`, { waitUntil: "networkidle", timeout: 120000 });
    await noPopup();
    const cont = p.locator("button", { hasText: "Lanjutkan isi laporan" });
    if (!(await cont.count())) console.log("- laporan: bukan draf, dilewati");
    else {
      await p.waitForTimeout(1000);
      // Popup bisa terbuka sendiri (langkah terakhir diingat); buka hanya bila belum
      if (!(await p.locator('nav[aria-label="Langkah laporan"]').isVisible())) await cont.click();
      await p.locator('nav[aria-label="Langkah laporan"] button').last().click();
      await p.evaluate(() => document.querySelector("[data-step]").insertAdjacentHTML("beforeend", '<label class="block">Kolom uji<input name="zzUji" class="input" required></label>'));
      await p.evaluate(() => document.querySelector("[data-step]").closest("form").requestSubmit());
      await p.waitForTimeout(800);
      const r = await p.evaluate(() => ({ step: document.querySelector("[aria-current=step]")?.textContent, focus: document.activeElement?.getAttribute("name") }));
      assert.equal(r.focus, "zzUji");
      assert.match(r.step ?? "", /^1/);
      console.log("✓ laporan: langkah 1 dibuka & kolom difokus");
    }
  }
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
