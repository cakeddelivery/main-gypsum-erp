// Smoke test UI: login per role lalu buka setiap halaman, laporkan error/konsol. node scripts/smoke.cjs [user] [paths...]
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL || "http://localhost:3000";
(async () => {
  const [user = "owner", ...paths] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto(BASE + "/login");
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', process.env.PW || "Gypsum#2026");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click('button[type="submit"]')]);
  for (const p of paths.length ? paths : ["/"]) {
    errors.length = 0;
    const res = await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 60000 });
    const h1 = await page.locator("h1").first().textContent().catch(() => "-");
    const shot = `/tmp/claude-0/-home-user/7f480491-3aaf-50e9-8774-6ded45b85c30/scratchpad/shot-${user}-${p.replace(/[^a-z0-9]/gi, "_")}.png`;
    if (process.env.SHOT) await page.screenshot({ path: shot, fullPage: true });
    console.log(`${res.status()} ${p} [${(h1 || "").trim()}] ${errors.length ? "ERR " + errors.join(" | ").slice(0, 400) : "ok"}`);
  }
  await browser.close();
})();
