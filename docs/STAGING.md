# Staging: cek fitur baru sebelum masuk produksi

Staging adalah salinan aplikasi yang berjalan di VPS yang sama, tetapi **terpisah total** dari produksi.

| | Produksi | Staging |
|---|---|---|
| Alamat | https://erp.maingypsum.shop | https://tes.maingypsum.shop |
| Folder | `~/main-gypsum-erp` | `~/main-gypsum-erp-staging` |
| Database | `maingypsum` | `maingypsum_staging` (salinan) |
| Port / PM2 | 3000 / `maingypsum` + `maingypsum-jadwal` | 3001 / `maingypsum-staging` |
| Jadwal otomatis (gaji, rekap, tutup buku) | aktif | **mati** |
| Bot Telegram | aktif | **mati** (tidak ada pesan ke karyawan) |
| Tampilan | normal | banner kuning "LINGKUNGAN STAGING" |

Login staging memakai username & password yang sama dengan produksi (karena datanya salinan), tetapi sesi login terpisah.
Apa pun yang diubah di staging **tidak** memengaruhi data asli.

## Pemasangan (sekali saja)

1. **Cloudflare** → DNS → tambah record `A`, nama `tes`, isi `43.173.38.131`, **Proxy: abu-abu (DNS only)** dulu.
2. Di VPS:
   ```bash
   cd ~/main-gypsum-erp && git pull origin main
   bash scripts/staging/setup.sh produksi
   sudo certbot --nginx -d tes.maingypsum.shop
   ```
   (`setup.sh contoh` bila ingin staging berisi data contoh, bukan salinan produksi.)
3. Setelah sertifikat terpasang, ubah record `tes` di Cloudflare menjadi **oranye (Proxied)**.
4. Buka https://tes.maingypsum.shop dan pastikan ada banner kuning.

## Alur kerja fitur baru

1. Fitur baru dikerjakan di **cabang terpisah** dan dibuka sebagai Pull Request (belum digabung ke `main`).
2. Pasang cabang itu di staging:
   ```bash
   bash ~/main-gypsum-erp/scripts/staging/deploy.sh <nama-cabang>
   ```
3. Cek di https://tes.maingypsum.shop. Kalau ada yang kurang, perbaikan didorong ke cabang yang sama, lalu jalankan perintah no. 2 lagi.
4. Kalau sudah oke, PR digabung ke `main`, lalu update produksi:
   ```bash
   cd ~/main-gypsum-erp && npm run update:prod
   ```
   (Pertama kali, sebelum skrip ada di server: `cd ~/main-gypsum-erp && git pull origin main && npm run update:prod`.)
   Isi skrip `scripts/update-prod.sh`: git pull → backup → npm ci → migrasi → **stop staging** → build ringan ke `.next-baru`
   → tukar ke `.next` (build lama di `.next-lama`) → restart `maingypsum` & `maingypsum-jadwal` → tampilkan commit.
   Situs tetap jalan selama build; berhenti di langkah yang gagal dengan pesan jelas.
5. **Setelah uji, matikan staging** agar RAM cukup untuk build produksi: `pm2 stop maingypsum-staging && pm2 save`.
6. (Opsional) kembalikan staging ke `main`: `bash ~/main-gypsum-erp/scripts/staging/deploy.sh main`

## Perintah lain

- **Perbarui data staging** dengan salinan terbaru produksi (produksi hanya dibaca):
  `bash ~/main-gypsum-erp/scripts/staging/refresh-data.sh`
  Pakai ini juga bila database staging jadi aneh setelah mencoba beberapa cabang dengan migrasi berbeda.
- **Hemat RAM** saat staging tidak dipakai: `pm2 stop maingypsum-staging` (nyalakan lagi: `pm2 start maingypsum-staging`).
- **Log staging**: `pm2 logs maingypsum-staging`
- **Build hemat memori** (VPS 3,6 GB): produksi & staging memakai `npm run build:ringan` (1 proses build, tanpa worker thread,
  batas memori Node 2 GB, tanpa lint/typecheck di dalam build — keduanya sudah dijalankan sebelum merge). `npm run build` biasa
  tetap memeriksa tipe. Bila build tetap macet: pastikan staging mati (`pm2 stop maingypsum-staging`) dan cek `free -h`.

## Catatan

- Staging berisi salinan data gaji & keuangan. Aksesnya tetap butuh login, dan halaman diberi tanda `noindex` agar tidak muncul di Google.
- Fitur AI (baca struk, advisor) memakai kunci AI yang sama dengan produksi.
- Untuk menguji Telegram di staging, buat bot terpisah lewat BotFather lalu isi `TELEGRAM_BOT_TOKEN` di `~/main-gypsum-erp-staging/.env`. **Jangan** pakai token bot produksi atau Magy Bot.
