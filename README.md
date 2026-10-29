# Main Gypsum Unified ERP

Sistem ERP terintegrasi untuk **Main Gypsum** dan **Dunia Lukis**: produksi & laporan shift, stok, karyawan & penggajian, Finance Inbox (manual / Telegram / AI Hermes), akuntansi double-entry, produk & HPP, serta pengaturan & hak akses. Mobile-first, berbasis role, IDR-only, zona waktu Asia/Jakarta.

> Cakupan: seluruh poin spesifikasi **kecuali poin 8 (integrasi Marketplace Shopee & TikTok Shop) dan poin 10 (Kalender Konten & KPI Marketing)**. Lihat [docs/AUDIT.md](docs/AUDIT.md) untuk pemetaan fitur, keputusan, dan hal yang perlu diverifikasi.

## Teknologi

- Next.js 15 (App Router, Server Actions) + React 19 + Tailwind CSS
- PostgreSQL 16 + Prisma ORM (kompatibel dengan Supabase PostgreSQL)
- Auth sendiri: bcrypt + sesi JWT (cookie httpOnly), kunci akun setelah 5 kali gagal
- Vitest (unit, integrasi, API) + Playwright (smoke & end-to-end)

## Menjalankan secara lokal

```bash
cp .env.example .env            # isi DATABASE_URL, AUTH_SECRET (≥32 karakter), dll.
npm install
npx prisma migrate deploy       # buat tabel + trigger audit append-only
npm run db:seed                 # data awal: COA, rekening, divisi, shift, produk, akun uji
npm run dev                     # http://localhost:3000
```

Akun uji hasil seed (password default `Gypsum#2026`, atau nilai `SEED_PASSWORD`). **Ganti password setelah login pertama.**

| Username | Role |
|---|---|
| owner | Owner |
| finance | Finance |
| admin | Admin |
| adminprod | Admin Produksi |
| adminmp | Admin Marketplace |
| kapten | Kapten Divisi (Divisi Cetak) |
| content | PIC Content Creator |
| operator | Operator (karyawan K002) |

## Variabel lingkungan

| Nama | Keterangan |
|---|---|
| `DATABASE_URL` | Koneksi PostgreSQL |
| `AUTH_SECRET` | Rahasia penandatangan sesi, min. 32 karakter, **berbeda** untuk staging & production |
| `APP_ENV` | `staging` atau `production` (staging menampilkan banner kuning) |
| `STORAGE_DIR` | Folder privat bukti transaksi (di luar folder publik) |
| `CRON_SECRET` | Token untuk `GET/POST /api/cron/run` |
| `TELEGRAM_BOT_TOKEN` | Token bot dari @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret header webhook Telegram |
| `HERMES_WEBHOOK_URL`, `HERMES_WEBHOOK_TOKEN` | Opsional, meneruskan pesan Telegram ke Hermes AI Agent |
| `ANTHROPIC_API_KEY` | Opsional, akses AI langsung ke Claude API untuk AI Advisor (menu Analitik) dan pembacaan foto bukti di bot Telegram |
| `AI_BASE_URL`, `AI_API_KEY` | Opsional, alternatif provider AI OpenAI-compatible (mis. `https://api.kelontongai.id/v1`). Bila diisi, dipakai menggantikan `ANTHROPIC_API_KEY` |
| `AI_MODEL` | Opsional, model default untuk semua fitur AI (default `claude-opus-5-5`, atau `claude-haiku-5.5` untuk provider OpenAI-compatible) |
| `ADVISOR_MODEL`, `RECEIPT_MODEL` | Opsional, model khusus untuk AI Advisor / baca foto bukti (menimpa `AI_MODEL`) |

## Aturan bisnis yang diterapkan

- **Gaji bulanan H+7**: siklus dari tanggal masuk s/d sehari sebelum tanggal yang sama bulan berikutnya; slip dibuat otomatis (06.00 WIB) saat siklus selesai, gajian 7 hari kemudian. Jatah libur 1 hari per 7 hari siklus, kelebihan = bolos (potong gaji ÷ 26/hari). Resign sebelum tanggal gajian = slip Rp0. Parameter di Pengaturan.
- **Borongan**: tugas per piece (Cat giftbox Rp100, Cat plastik Rp15, Assembling Rp60, bisa diubah), dicatat per pekerja dan dibayar saat pekerja klaim (Penggajian › Borongan & klaim).
- **Kasbon**: Dr Piutang Karyawan / Cr rekening; dipotong otomatis dari slip berikutnya (penuh atau cicilan) dan tampil di slip JPG.
- **Pembelian bahan baku** (Stok › Pembelian): lunas, bertahap (DP), atau tempo; stok masuk, jurnal, dan sisa utang tercatat sekaligus.
- **Pinjaman modal** (Akuntansi › Piutang, utang & pinjaman › Pinjaman modal), cicilan bisa dengan bunga.
- **Dana sisihan harian** (Finance › Dana sisihan): kompensasi pengelola (owner) dibebankan dan dipindah Seabank → ShopeePay sampai diambil; tabungan atau cicilan harian pinjaman modal.
- **Laporan penutup shift per divisi** (Produksi, Giftbox, Packing, Assembling): detail hasil kerja sesuai format divisi, checklist penutupan dengan foto bukti per tugas, stok akhir shift bahan baku divisi (jadi stock opname saat laporan dikirim), dan daftar order otomatis untuk bahan dengan stok ≤ limit (Laporan Shift › Order bahan baku). Bahan baku, limit, dan checklist tiap divisi diatur Owner di Laporan Shift › Bahan & checklist divisi. Setelah update pertama jalankan `npm run setup:divisi` (sekali) untuk membuat divisi & bahan baku dari contoh laporan dan mengganti bahan baku lama.
- **Absensi & target produksi**: validasi/atur absensi dan target produksi hanya untuk Owner, Supervisor, dan Finance.
- **Analitik & advisor**: 12 bulan pendapatan/beban/laba/kas, growth, kas bebas, kewajiban & proyeksi 30 hari, saran otomatis, dan AI advisor opsional.

## Produksi & staging

1. Siapkan **dua** database, dua `AUTH_SECRET`, dan dua bot Telegram (staging & production).
2. `npm ci && npm run build && npx prisma migrate deploy && npm start`.
3. Penjadwal (pilih salah satu):
   - Proses terpisah: `npm run scheduler` (cek tiap menit), **atau**
   - Cron eksternal tiap 5–15 menit: `curl -H "Authorization: Bearer $CRON_SECRET" https://domain/api/cron/run`.
   Job: rekap harian Telegram **07.00 WIB**, tutup buku bulan lalu **tanggal 1 pukul 09.00 WIB**.
4. Pasang webhook Telegram:
   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://domain/api/telegram/webhook -d secret_token=$TELEGRAM_WEBHOOK_SECRET
   ```
5. Monitoring: `GET /api/health` (status DB). Backup: `npm run backup` (pg_dump, simpan 14 hari) dan `npm run restore -- backups/<file>.dump`. Sertakan `STORAGE_DIR` dalam backup.

## Telegram & Hermes AI

Alur: **Telegram Bot → Hermes AI Agent → Finance API `/api/v1` → Finance Inbox (draft) → konfirmasi manusia → jurnal.**

- Owner mengelola identitas Telegram, API key Hermes, dan log di **Pengaturan → Telegram & Hermes** (menu khusus Owner).
- Hermes memakai API key ber-scope `finance:read` / `finance:draft`. Tidak ada endpoint untuk membukukan dan tidak ada akses SQL.
- Setiap POST/PATCH wajib `Idempotency-Key`. Dokumentasi ringkas: `GET /api/v1`.
- Tombol **Konfirmasi** di Telegram hanya membukukan bila ID Telegram dipetakan ke pengguna yang punya izin *Setujui & bukukan transaksi*.
- Tanpa `HERMES_WEBHOOK_URL`, bot memakai ekstraksi aturan lokal (nominal, tanggal, rekening, kategori, catatan).

## Pengujian

```bash
npm test                 # reset DB test lokal (*_test) lalu jalankan 34 test Vitest
npm run typecheck
node scripts/e2e.cjs     # alur end-to-end di browser (server harus berjalan)
node scripts/smoke.cjs owner / /finance /akuntansi   # smoke per halaman per role
```

## Struktur

```
prisma/            schema, migrasi (termasuk trigger append-only), seed
src/lib/           logika domain: accounting, finance, stock, payroll, attendance, hpp, bot, jobs, rbac, auth
src/app/(app)/     halaman: dashboard, produksi, laporan, absensi, stok, produk, karyawan, gaji, finance, akuntansi, pengaturan
src/app/api/       /api/v1 (Hermes), /api/telegram/webhook, /api/cron/run, /api/health, bukti privat
tests/             unit, integrasi, API
scripts/           scheduler, backup/restore, smoke & e2e
```
