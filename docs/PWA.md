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

Nginx tidak perlu diubah: semua permintaan diteruskan ke Next.js yang sudah memberi header yang benar.
