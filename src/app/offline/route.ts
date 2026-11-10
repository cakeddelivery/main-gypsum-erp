import { pwaInfo } from "@/lib/pwa";

// Halaman "Sedang offline" yang disimpan service worker (public/sw.js).
// Dibuat sebagai HTML mandiri (CSS di dalam, tanpa JavaScript Next.js) agar tetap tampil utuh tanpa internet.
export const dynamic = "force-static";

export function GET() {
  const p = pwaInfo();
  const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2559b8">
<meta name="robots" content="noindex">
<title>Sedang offline · ${p.name}</title>
<script>try{var t=localStorage.getItem("mg-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.dataset.theme="dark"}catch(e){}</script>
<style>
:root{color-scheme:light;--bg:#f1f5f9;--card:#fff;--tx:#1e293b;--mut:#475569;--bd:#e2e8f0;--btn:#2559b8;--btnh:#1e4a9c}
[data-theme="dark"]{color-scheme:dark;--bg:#0b1120;--card:#111a2e;--tx:#e2e8f0;--mut:#cbd5e1;--bd:#1f2a44;--btn:#2f63c0;--btnh:#2559b8}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;padding:16px;padding-bottom:max(16px,env(safe-area-inset-bottom))}
.card{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:28px 22px;max-width:380px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
img{width:72px;height:72px;border-radius:16px}
h1{font-size:20px;margin:16px 0 8px}
p{color:var(--mut);font-size:15px;line-height:1.5;margin:0 0 20px}
button{appearance:none;border:0;border-radius:10px;background:var(--btn);color:#fff;font-size:16px;font-weight:600;padding:12px 20px;width:100%;cursor:pointer}
button:hover{background:var(--btnh)}
</style>
</head>
<body>
<main class="card">
<img src="${p.icon(192)}" alt="" width="72" height="72">
<h1>Sedang offline</h1>
<p>Sambungkan internet lalu coba lagi. Data ERP hanya bisa dibuka saat online.</p>
<button type="button" onclick="location.reload()">Coba lagi</button>
</main>
<script>addEventListener("online",function(){location.reload()})</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
