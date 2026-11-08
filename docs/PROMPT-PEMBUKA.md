Halo Claude. Aku CAK ED, owner Main Gypsum (Lamongan). Aku melanjutkan pengembangan ERP website-ku dari akun Claude lain. Tolong lanjutkan dengan aturan berikut.

PROYEK
- Repo GitHub: cakeddelivery/main-gypsum-erp (privat, branch utama main). Stack: Next.js 15 + React 19 + Tailwind + PostgreSQL/Prisma, auth sendiri, tes Vitest.
- Sebelum mengerjakan apa pun, BACA DULU file docs/SERAH-TERIMA.md di repo itu (tujuan, fitur, aturan bisnis, deploy, bot Telegram, AI, skrip data, riwayat PR, pekerjaan terbuka). Lalu README.md dan docs/STAGING.md. Anggap isinya sebagai aturan tetap proyek.
- Production: https://erp.maingypsum.shop. Staging: https://tes.maingypsum.shop. Keduanya di VPS-ku sendiri. Kamu tidak bisa SSH; aku yang menjalankan perintah di VPS lalu menempel hasilnya.

ALUR KERJA WAJIB
1. Setiap fitur/perbaikan dibuat di branch sendiri + pull request (draft), jangan langsung ke main.
2. Di balasanmu selalu berikan perintah tes staging: bash ~/main-gypsum-erp/scripts/staging/deploy.sh <nama-branch>
3. Aku cek di tes.maingypsum.shop. Kalau ada masalah, perbaiki di branch yang sama.
4. Merge ke main HANYA setelah aku bilang staging OK. Lalu beri perintah update production:
   cd ~/main-gypsum-erp && git pull origin main && npm run backup && npm ci && npx prisma migrate deploy && npm run build && pm2 restart maingypsum maingypsum-jadwal --update-env
   (plus skrip data tambahan bila ada; skrip selalu pratinjau dulu, lalu "-- --jalankan").

ATURAN PENTING
- Selalu jawab dalam bahasa Indonesia yang sederhana. Aku bukan programmer: beri perintah lengkap siap tempel.
- Kalau ada yang tidak jelas, tanya dengan pilihan/opsi (pilihan ganda) dan beri rekomendasimu.
- Jangan pernah minta aku menempel password, token bot, API key, atau isi .env di chat.
- Bot Telegram ERP terpisah. Magy Bot (@Maingypsum_bot) milik Hermes, JANGAN pakai tokennya di ERP.
- AI di ERP memakai KelontongAI (OpenAI-compatible) lewat AI_BASE_URL/AI_API_KEY/AI_MODEL di .env VPS, karena aku tidak punya kartu kredit.
- Transaksi yang sudah dibukukan tidak dihapus, hanya dibatalkan dengan jurnal balik. Semua Kode dibuat otomatis.
- Tanyakan dulu sebelum langkah yang tidak bisa dibatalkan (hapus data production, dll.).

LANGKAH PERTAMA
Setelah membaca docs/SERAH-TERIMA.md, rangkum dalam 5-8 poin apa yang kamu pahami tentang proyek ini, lalu tampilkan daftar "Pekerjaan terbuka" (bagian 11) sebagai pilihan, supaya aku pilih mana yang dikerjakan duluan.
