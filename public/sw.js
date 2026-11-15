/* Service worker Main Gypsum ERP.
 * Prinsip: data ERP privat & perlu login, jadi halaman/data/API TIDAK PERNAH disimpan.
 * - Navigasi halaman: selalu ke jaringan; bila gagal (offline) tampilkan /offline.
 * - Yang disimpan hanya aset statis yang tidak berubah: /_next/static/* (nama file ber-hash) dan ikon /pwa/.
 * - /api/*, /files/*, POST, server action: tidak disentuh sama sekali.
 * - Notifikasi push: tampilkan judul/isi dari server; ketuk → buka (atau fokuskan) halaman ERP terkait.
 * Naikkan VERSION bila isi file ini diubah; cache lama dibersihkan saat activate. */
const VERSION = "v2";
const PRECACHE = `mg-precache-${VERSION}`;
const STATIC = `mg-static-${VERSION}`;
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [OFFLINE_URL, "/pwa/icon-192.png", "/pwa/icon-192-tes.png"];
const STATIC_MAX = 300;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((c) => c.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mg-") && k !== PRECACHE && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - STATIC_MAX; i++) await cache.delete(keys[i]);
}

async function cacheFirst(req) {
  const hit = await caches.match(req); // termasuk ikon yang sudah di-precache
  if (hit) return hit;
  const cache = await caches.open(STATIC);
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {});
  }
  return res;
}

async function networkOnlyPage(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/files/")) return;

  if (req.mode === "navigate") {
    event.respondWith(networkOnlyPage(req));
    return;
  }
  if (p.startsWith("/_next/static/") || p.startsWith("/pwa/")) {
    event.respondWith(cacheFirst(req));
  }
  // Selain itu (RSC, gambar, dll.) dibiarkan ke browser seperti biasa, tanpa cache.
});

// ---------------- Notifikasi push ----------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Main Gypsum ERP";
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/pwa/icon-192.png",
      badge: "/pwa/icon-192.png",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Pakai jendela ERP yang sudah terbuka bila ada, lalu pindah ke halaman tujuan
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          return c.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : self.clients.openWindow(url)));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
