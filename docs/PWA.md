# Aplikasi terpasang (PWA)

ERP bisa dipasang di layar utama HP (Android Chrome & iPhone Safari) dan komputer (Chrome/Edge).

| Bagian | File |
|---|---|
| Manifest (nama, ikon, shortcut) | `src/app/manifest.ts` → `/manifest.webmanifest` |
| Nama/ikon produksi vs staging (`APP_ENV=staging` → "MG ERP (Tes)", ikon berpita TES) | `src/lib/pwa.ts` |
| Ikon (192, 512, maskable 512, apple 180, 96 untuk shortcut) | `public/pwa/` — dibuat ulang dengan `node scripts/pwa-icons.mjs` dari `src/app/icon.png` |
| Service worker | `public/sw.js` (header no-cache di `next.config.mjs`) |
| Halaman offline (HTML mandiri, tanpa data) | `src/app/offline/route.ts` → `/offline` |
| Daftar SW + kartu "Pasang aplikasi" di Profil | `src/components/Pwa.tsx` |
| Cek otomatis (butuh build berjalan) | `node scripts/pwa-check.cjs` |

Aturan service worker:
- Halaman, data, dan API ERP **tidak pernah disimpan** (privat, perlu login). Navigasi selalu ke jaringan; bila gagal tampil `/offline`.
- Hanya `/_next/static/*` (nama file ber-hash) dan ikon `/pwa/*` yang disimpan; maks 300 file, sisanya dibuang.
- `/api/*`, `/files/*`, POST, dan server action tidak disentuh.
- SW hanya didaftarkan pada build produksi (`npm run build`), tidak saat `npm run dev`.
- Bila `public/sw.js` diubah, naikkan `VERSION` di dalamnya; cache lama dihapus otomatis saat versi baru aktif (skipWaiting + clients.claim).

## Pembaruan otomatis setelah deploy

Aplikasi terpasang jarang ditutup, jadi HP bisa terus menjalankan JS lama setelah deploy. Penanganannya:

| Bagian | File |
|---|---|
| Versi build (commit + waktu build; bisa ditimpa env `APP_BUILD_ID`) ditanam ke kode & dipakai sebagai build id Next | `next.config.mjs` |
| Versi server yang sedang jalan (publik, `no-store`) | `src/app/api/version/route.ts` → `/api/version` |
| Versi halaman yang terbuka | `<meta name="app-build">` di `src/app/layout.tsx` |
| Logika (versi baru?, error versi lama?, cegah muat ulang berulang, sedang mengisi?) | `src/lib/appVersion.ts` (tes: `tests/appVersion.test.ts`) |
| Pengecek di HP + pemberitahuan | `src/components/AppUpdater.tsx` (dipasang di root layout) |

- Dicek saat aplikasi dibuka lagi (visibilitychange/focus/pageshow/online), tiap 5 menit selama terlihat, dan saat muncul error versi lama. Setiap cek juga memanggil `registration.update()` service worker.
- Versi baru + tidak sedang mengisi → langsung dimuat ulang diam-diam.
- Ada popup terbuka / kolom sedang diketik / form yang sudah diubah → tampil "Versi baru tersedia" (tombol **Muat ulang**), isian tidak dihapus, dan dimuat ulang otomatis begitu popup ditutup. Popup pemberitahuan tanpa isian diberi `data-update-safe` agar tidak menahan pembaruan (pengingat Gmail, pratinjau JPG).
- `ChunkLoadError` dan "Server Action … was not found" (error karena versi lama) → muat ulang satu kali; muat ulang otomatis paling sering sekali per menit sehingga tidak berulang.
- Uji manual dua build: `node <skrip uji>` membangun `APP_BUILD_ID=A`, membuka halaman, lalu menjalankan build B; halaman A harus berganti ke B.

Nginx tidak perlu diubah: semua permintaan diteruskan ke Next.js (tanpa proxy_cache) yang sudah memberi header yang benar
(`/sw.js` no-store, `/manifest.webmanifest` no-cache, `/api/version` no-store).
Cloudflare bawaan menghormati header itu dan tidak menyimpan HTML. Bila suatu saat dibuat Cache Rule "Cache Everything",
tambahkan pengecualian (Bypass cache) untuk path `/sw.js`, `/manifest.webmanifest`, dan `/api/`.
