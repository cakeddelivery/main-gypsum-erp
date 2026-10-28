// Uji alur end-to-end via browser. node scripts/e2e.cjs (server harus jalan di BASE_URL)
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const PW = process.env.PW || "Gypsum#2026";
const SHOTS = process.env.SHOTS_DIR;
let failed = 0;
async function login(browser, user, mobile) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  await page.goto(BASE + "/login");
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), page.click('button[type="submit"]')]);
  return page;
}
async function step(name, fn) {
  try { await fn(); console.log("✓", name); } catch (e) { failed++; console.log("✗", name, "-", e.message.split("\n")[0]); }
}
const status = (page) => page.locator('[role="status"]').last();
(async () => {
  const browser = await chromium.launch();
  // --- Finance: input manual dengan ekstraksi, ajukan, setujui
  const fin = await login(browser, "finance");
  await step("Finance: ekstraksi & ajukan transaksi", async () => {
    await fin.goto(BASE + "/finance/baru");
    await fin.fill('textarea[name="rawText"]', `beli gypsum ${2000000 + Math.floor(Math.random() * 99999)} dari seabank hari ini`);
    await fin.click("text=Ekstrak otomatis");
    await fin.waitForFunction(() => Number(document.querySelector('input[name="amount"]').value) > 2000000);
    await Promise.all([fin.waitForURL(/\/finance\/c/), fin.click('button[value="submit"]')]);
    await fin.getByText("Menunggu Konfirmasi").first().waitFor();
  });
  await step("Finance: setujui & bukukan", async () => {
    fin.once("dialog", (d) => d.accept());
    await fin.click("text=✓ Setujui & bukukan");
    await status(fin).getByText(/dibukukan/).waitFor();
    await fin.reload();
    await fin.getByText(/^Jurnal JU-/).first().waitFor();
  });
  await step("Akuntansi: neraca seimbang", async () => {
    await fin.goto(BASE + "/akuntansi/neraca");
    await fin.getByText("✓ Neraca seimbang").waitFor();
  });
  // --- Operator (mobile): absen & input produksi
  const op = await login(browser, "operator", true);
  await step("Operator: navigasi bawah tampil", async () => { await op.locator("nav.fixed").getByText("Absen").waitFor(); });
  await step("Operator: absen masuk", async () => {
    await op.goto(BASE + "/absensi");
    await op.click("text=Absen masuk sekarang");
    await status(op).getByText(/Absen/).waitFor();
  });
  await step("Operator: input hasil produksi", async () => {
    await op.goto(BASE + "/produksi");
    await op.click("text=+ Input hasil");
    await op.selectOption('select[name="stage"]', "CETAK");
    await op.fill('input[name="qtyGood"]', "120");
    await op.fill('input[name="qtyReject"]', "5");
    await op.click("text=Simpan hasil");
    await op.getByText("Hasil produksi tersimpan").waitFor();
    await op.reload();
    await op.locator("td", { hasText: "120" }).first().waitFor();
  });
  await step("Operator: akses Finance ditolak", async () => {
    await op.goto(BASE + "/finance");
    await op.getByText("Akses ditolak").waitFor();
  });
  if (SHOTS) await op.goto(BASE + "/"), await op.screenshot({ path: SHOTS + "/operator-home.png", fullPage: true });
  // --- Kapten: laporan shift
  const kp = await login(browser, "kapten");
  await step("Kapten: buat & kirim laporan shift", async () => {
    await kp.goto(BASE + "/laporan");
    const open = kp.locator("a", { hasText: "Buka" }).first();
    const create = kp.locator("button", { hasText: "Buat" }).first();
    await Promise.all([kp.waitForURL(/\/laporan\/c/), (await create.count()) ? create.click() : open.click()]);
    await kp.check('input[name="check_0"]');
    await kp.fill('textarea[name="complaints"]', "Cetakan no. 3 retak");
    await kp.click("text=Simpan");
    await status(kp).getByText("Laporan tersimpan").waitFor();
    await kp.getByRole("button", { name: "Kirim laporan" }).click();
    await kp.getByText(/Laporan terkirim|Pengiriman gagal/).first().waitFor();
    await kp.reload();
    await kp.getByText("Riwayat pengiriman").waitFor();
  });
  // --- Admin produksi: mutasi stok
  const ap = await login(browser, "admin");
  await step("Admin: penerimaan stok", async () => {
    await ap.goto(BASE + "/stok/mutasi");
    await ap.selectOption('select[name="type"]', "PENERIMAAN");
    await ap.fill('input[name="qty"]', "50");
    const opts = await ap.locator('select[name="toLocationId"] option').allTextContents();
    await ap.selectOption('select[name="toLocationId"]', { label: opts.find((o) => o.includes("Bahan Baku")) });
    await ap.fill('input[name="unitCost"]', "4600");
    await ap.click("text=Simpan mutasi");
    await status(ap).getByText("Mutasi stok tercatat").waitFor();
  });
  await step("Admin: buat & hitung periode gaji", async () => {
    await ap.goto(BASE + "/gaji");
    await ap.click("text=+ Periode");
    await ap.fill('input[name="code"]', "GJ-E2E-" + Date.now());
    await ap.click("text=Buat periode");
    await ap.getByText("Periode dibuat").waitFor();
    await ap.reload();
    await ap.locator("a", { hasText: "Buka" }).first().click();
    await ap.click("text=Hitung ulang");
    await status(ap).getByText("Slip gaji dihitung").waitFor();
  });
  // --- Owner: dashboard & settings
  const ow = await login(browser, "owner");
  await step("Owner: dashboard menampilkan saldo", async () => { await ow.goto(BASE + "/"); await ow.getByText("Saldo rekening").first().waitFor(); });
  await step("Owner: buat API key Hermes (tampil sekali)", async () => {
    await ow.goto(BASE + "/pengaturan/telegram");
    await ow.click("text=Buat API key");
    await ow.getByText(/mgk_[a-f0-9]{8}_/).first().waitFor();
  });
  if (SHOTS) {
    for (const [p, n] of [["/", "owner-dashboard"], ["/finance", "finance-inbox"], ["/akuntansi/laba-rugi", "laba-rugi"], ["/produksi", "produksi"]]) {
      await ow.goto(BASE + p); await ow.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
    }
  }
  await browser.close();
  console.log(failed ? `${failed} langkah GAGAL` : "Semua langkah lulus");
  process.exit(failed ? 1 : 0);
})();
