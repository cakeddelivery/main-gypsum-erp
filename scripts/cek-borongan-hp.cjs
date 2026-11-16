const { chromium } = require('playwright');
// Cek tampilan HP alur kiriman borongan (360 px): tidak ada geser samping, popup Terima/Kirim/Ambil/Bagi/Lapor terbuka.
// Butuh server jalan + akun owner, driver, dan koordinator: U_OWNER/U_DRIVER/U_KOOR, P (password), BASE, SHOTS (folder screenshot).
const SP = process.env.SHOTS || '.';
const BASE = process.env.BASE || 'http://localhost:3000';
async function login(b, user) {
  const p = await b.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2 });
  await p.goto(BASE + '/login');
  await p.fill('input[name=username]', user); await p.fill('input[name=password]', process.env.P);
  await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 90000 }), p.click('button[type=submit]')]);
  await p.addStyleTag({ content: 'dialog.lengkapi{display:none!important}' }).catch(()=>{});
  return p;
}
async function kill(p) { await p.waitForTimeout(1500); await p.evaluate(() => document.querySelectorAll('dialog[aria-labelledby="lengkapi-akun"]').forEach((d) => d.remove())); }
async function overflow(p, label) {
  await kill(p);
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log(label, 'overflow', r.sw > r.cw ? `YA ${r.sw}>${r.cw}` : 'tidak');
}
(async () => {
  const b = await chromium.launch();
  let p = await login(b, process.env.U_OWNER || 'owner');
  await p.goto(BASE + '/borongan?tab=kiriman', { waitUntil: 'networkidle', timeout: 120000 });
  await overflow(p, 'owner list');
  await p.screenshot({ path: `${SP}/k1-owner.png`, fullPage: true });
  await p.getByRole('button', { name: 'Terima' }).first().click(); await p.waitForTimeout(600);
  await p.screenshot({ path: `${SP}/k2-terima.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.getByRole('button', { name: '+ Kirim Bahan' }).click(); await p.waitForTimeout(600);
  await p.screenshot({ path: `${SP}/k3-kirim.png` });
  await p.close();
  p = await login(b, process.env.U_DRIVER);
  await p.goto(BASE + '/borongan', { waitUntil: 'networkidle', timeout: 120000 });
  await overflow(p, 'driver');
  await p.screenshot({ path: `${SP}/k4-driver.png`, fullPage: true });
  await p.getByRole('button', { name: 'Ambil setoran' }).first().click(); await p.waitForTimeout(600);
  await p.getByLabel('Selesai semua').first().check(); await p.waitForTimeout(300);
  await p.screenshot({ path: `${SP}/k5-ambil.png`, fullPage: false });
  await p.reload({ waitUntil: 'networkidle' }); await kill(p);
  await p.getByRole('button', { name: /Bagi ke pekerja/ }).first().click(); await p.waitForTimeout(600);
  await p.screenshot({ path: `${SP}/k6-bagi.png` });
  await p.close();
  p = await login(b, process.env.U_KOOR);
  await p.goto(BASE + '/borongan', { waitUntil: 'networkidle', timeout: 120000 });
  await overflow(p, 'koordinator');
  await p.getByRole('button', { name: /Lapor hasil/ }).first().click(); await p.waitForTimeout(600);
  await p.screenshot({ path: `${SP}/k7-lapor.png` });
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
