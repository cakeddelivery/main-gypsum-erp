Halo Claude. Aku CAK ED, owner Main Gypsum (Lamongan). Aku melanjutkan pengembangan ERP website-ku di sesi/akun Claude ini. Tolong lanjutkan dengan aturan berikut.

PROYEK
- Repo GitHub: cakeddelivery/main-gypsum-erp (privat, branch utama main). Stack: Next.js 15 + React 19 + Tailwind + PostgreSQL/Prisma, auth sendiri, tes Vitest, bot Telegram, PWA.
- Sebelum mengerjakan apa pun, BACA DULU docs/SERAH-TERIMA.md di repo (tujuan, fitur, aturan bisnis, deploy, VPS, bot Telegram & grup, AI, skrip data, riwayat PR, pekerjaan terbuka, kondisi data). Lalu README.md dan docs/STAGING.md. Anggap isinya aturan tetap proyek.
- Production: https://erp.maingypsum.shop. Staging: https://tes.maingypsum.shop. Keduanya di VPS-ku ("VPS magy"). Kamu tidak bisa SSH; aku yang menjalankan perintah di VPS lalu menempel hasilnya (sering berupa screenshot dari HP).

CARA KERJA
- Kamu boleh menjadi KOORDINATOR: setiap tugas besar dibuka sebagai sesi/utas sendiri (branch + PR sendiri), utas melapor ke koordinator, koordinator memverifikasi (typecheck + npm test minimal 2x), meneruskan pertanyaan kepadaku dengan pilihan tombol, lalu merge setelah aku setuju. Tugas kecil boleh dikerjakan koordinator sendiri.

ALUR KERJA WAJIB
1. Setiap fitur/perbaikan dibuat di branch sendiri + pull request (draft), jangan langsung ke main.
2. Di balasanmu selalu berikan perintah tes staging: bash ~/main-gypsum-erp/scripts/staging/deploy.sh <nama-branch>
   (staging biasanya dimatikan untuk hemat RAM; deploy.sh menyalakannya lagi. Bila ada migrasi, jalankan dulu bash ~/main-gypsum-erp/scripts/staging/refresh-data.sh)
3. Aku cek di tes.maingypsum.shop. Kalau ada masalah, perbaiki di branch yang sama.
4. Merge ke main HANYA setelah aku bilang "staging OK" atau "merge #N". Fitur bot Telegram tidak bisa dites di staging; boleh langsung merge bila aku minta. Lalu beri perintah update production:
   cd ~/main-gypsum-erp && git pull origin main && npm run backup && npm ci && npx prisma migrate deploy && npm run build && pm2 restart maingypsum maingypsum-jadwal --update-env
   (plus skrip data bila ada; skrip selalu pratinjau dulu, lalu "-- --jalankan" setelah npm run backup).

ATURAN PENTING
- Selalu jawab dalam bahasa Indonesia yang sederhana. Aku bukan programmer: beri perintah lengkap siap tempel, satu blok per langkah.
- Kalau ada yang tidak jelas, tanya dengan pilihan/opsi (pilihan ganda) dan beri rekomendasimu.
- Jangan pernah minta aku menempel password, token bot, API key, App Password Gmail, client secret Google, atau isi .env di chat.
- Bot Telegram ERP ("Main Gypsum ERP") terpisah dari Magy Bot (@Maingypsum_bot, milik Hermes). JANGAN pakai token Magy Bot di ERP.
- AI di ERP memakai KelontongAI (OpenAI-compatible) lewat .env VPS, karena aku tidak punya kartu kredit.
- Transaksi yang sudah dibukukan tidak dihapus, hanya dibatalkan dengan jurnal balik. Semua Kode dibuat otomatis. Saldo setiap rekening di ERP harus sama dengan aplikasi bank.
- Tanyakan dulu sebelum langkah yang tidak bisa dibatalkan (hapus data production, dll.).

LANGKAH PERTAMA
Setelah membaca docs/SERAH-TERIMA.md, rangkum dalam 5–8 poin apa yang kamu pahami tentang proyek ini, lalu tampilkan daftar "Pekerjaan terbuka" (bagian 11) sebagai pilihan, supaya aku pilih mana yang dikerjakan duluan.
