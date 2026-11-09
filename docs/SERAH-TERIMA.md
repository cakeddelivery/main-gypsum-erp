# Serah-terima proyek Main Gypsum ERP

Dokumen ini merangkum semua yang perlu diketahui untuk melanjutkan pengembangan ERP Main Gypsum di akun Claude lain. Posisi per **8 November 2026**, kode di `main` sampai PR #44 (commit `1be5585`). PR #38 (skrip audit saldo, baca-saja) dan PR #44 (dropdown cari melebar) sudah di-merge.

> Tidak ada rahasia di dokumen ini. Token bot, API key, password, isi `.env` tidak pernah ditulis di repo atau di chat. Semua rahasia hanya ada di `.env` VPS.

---

## 1. Tujuan dan ruang lingkup

- Membangun website ERP untuk **Main Gypsum** (mainan/kerajinan gypsum, tagline "Sahabat Kreatif Anak", Lamongan) dan toko kedua **Dunia Lukis**, dari spesifikasi PDF milik user: *"Main Gypsum Unified ERP Fitur Gabungan"* (13 poin).
- **Dikecualikan**: poin 8 (integrasi API marketplace Shopee/TikTok Shop) dan poin 10 (kalender konten & KPI marketing). Peran/akun marketplace tetap ada, tapi tidak ada impor otomatis dari marketplace. Penjualan dicatat manual.
- Dibangun dari nol (aplikasi lama "Laporan Shift Divisi" dan "Finance AI Staging" tidak tersedia).
- Pemilik/pengelola: **CAK ED** (owner) dan **Jojo** (pengelola kedua).

## 2. Repo dan teknologi

- Repo: **github.com/cakeddelivery/main-gypsum-erp** (privat), branch utama `main`.
- Next.js 15 (App Router, Server Actions) + React 19 + Tailwind CSS 3.
- PostgreSQL 16 + Prisma 6 (69 model). Jurnal akuntansi append-only (trigger DB, tidak bisa diubah/dihapus; koreksi = jurnal balik).
- Auth sendiri: bcrypt + JWT di cookie httpOnly, kunci akun setelah 5x gagal login.
- Tes: Vitest (`npm test`, butuh DB `*_test` lokal) + `npm run typecheck`. Playwright untuk smoke/e2e (`scripts/smoke.cjs`, `scripts/e2e.cjs`).
- `playwright-core` + Chromium headless dipakai **di server** untuk membuat JPG laporan yang dikirim bot.
- `tesseract.js` untuk OCR foto bukti transfer (di browser lewat `public/ocr`, dan di server sebagai cadangan bila AI gagal).
- Mobile-first, IDR saja, zona waktu Asia/Jakarta, seluruh UI bahasa Indonesia.

### Struktur kode

```
prisma/schema.prisma, migrations/, seed.ts
src/lib/            logika domain (lihat daftar di bawah)
src/app/(app)/      halaman per menu
src/app/api/        v1 (API Hermes), telegram (webhook bot), cron, files (bukti privat), health
scripts/            scheduler, backup/restore, skrip perbaikan data, staging/
tests/              unit + integrasi (Vitest)
docs/               AUDIT.md, STAGING.md, SERAH-TERIMA.md (dokumen ini)
```

Menu (folder `src/app/(app)/`): beranda (dashboard), `produksi`, `laporan` (laporan shift), `absensi`, `stok`, `produk` (produk & HPP), `borongan`, `karyawan`, `gaji`, `finance` (menu "Transaksi"), `akuntansi`, `analitik`, `supplier`, `pelanggan`, `pengaturan`, `profil`.

File `src/lib/` yang paling penting:

| File | Isi |
|---|---|
| `accounting.ts` | jurnal double-entry, COA, tutup buku, arus kas (`cashMovements`) |
| `finance.ts` | transaksi keuangan: draft → bukukan, batalkan (jurnal balik), ubah rekening/kategori (`reclassifyBooked`), rincian/split |
| `payroll.ts` | siklus gaji, slip, bolos, kasbon, akrual gaji |
| `attendance.ts`, `attendanceSelf.ts` | absensi + geofence GPS |
| `stock.ts`, `items.ts`, `itemCategories.ts`, `unitcost.ts` | stok, master barang, kategori (dari DB), harga pokok rata-rata |
| `purchase.ts`, `payables.ts`, `suppliers.ts` | pembelian, hutang & pinjaman + cicilan, supplier + alias |
| `hpp.ts`, `pricing.ts`, `productProfit.ts` | resep HPP, overhead, harga jual per kanal, laba per produk |
| `borongan.ts` | borongan tetangga (titik, orang, serah terima, hasil, pelunasan) |
| `reserve.ts`, `reserveSync.ts`, `talangan.ts` | dana sisihan harian, sinkron transfer ↔ sisihan, dana talangan |
| `bot.ts`, `botMenu.ts`, `botFlow.ts`, `botFlow3.ts`, `botKit.ts`, `botPurchase.ts`, `telegram.ts` | bot Telegram |
| `receipt.ts`, `ai.ts`, `ocrReceipt.ts`, `ocrReceiptText.ts`, `ocrAmount.ts`, `extract.ts` | baca foto bukti (AI lalu OCR cadangan), ekstraksi teks |
| `render.ts` | JPG di server (Chromium headless) |
| `rbac.ts`, `auth.ts`, `nav.ts` | role & izin, sesi, menu per role |
| `codes.ts` | kode otomatis semua data |
| `jobs.ts`, `alerts.ts` | job terjadwal, peringatan dashboard |
| `shiftReport.ts`, `divisionSetup.ts` | format laporan penutup shift per divisi |

Role (`enum Role`): OWNER, FINANCE, ADMIN, ADMIN_PRODUKSI, ADMIN_MARKETPLACE, KAPTEN_DIVISI, SUPERVISOR, PIC_CONTENT, OPERATOR, KOORDINATOR (koordinator titik borongan).

## 3. Fitur yang sudah jadi (ringkas)

- **Produksi & laporan shift** per divisi (Produksi/Cetak-Oven 2 shift, Giftbox, Packing, Assembling 1 shift). Laporan shift = stock opname bahan baku divisi + checklist foto. Reject + alasan reject.
- **Stok**: master barang per kategori & divisi, mutasi, permintaan, opname, tab stok minus, reorder bila stok ≤ limit, **opname barang jadi akhir bulan → HPP** (penurunan barang jadi dibukukan ke 5-1000).
- **Pembelian**: banyak barang per pembelian, supplier inline, Tagihan/Nominal bayar/Status (bayar kurang = Hutang dengan jatuh tempo), foto bukti dibaca otomatis.
- **Produk & HPP**: resep 4 bagian (bahan dengan satuan pakai, tenaga kerja, overhead, kemasan), overhead per bulan ÷ output, target margin, harga saran offline/Shopee/TikTok (biaya marketplace di setting `marketplace_fees`), laba & reject per produk (estimasi).
- **Borongan tetangga** (`/borongan`): titik BMR & Mastrip, koordinator login, serah terima bahan lewat driver, setoran hasil, pelunasan upah.
- **Karyawan, absensi GPS (geofence), penggajian**: slip JPG, kasbon, tunjangan tgl 15, akrual gaji.
- **Transaksi** (route `/finance`, dulu "Finance Inbox"): manual/bot, draft → dibukukan, batalkan + jurnal balik, hapus yang Dibatalkan/Ditolak, ubah rekening/kategori transaksi dibukukan, rincian multi-kategori, withdraw marketplace (inisial MG/DL/WD), deteksi duplikat, mutasi per rekening (`/finance/mutasi`), dana sisihan, dana talangan (`/finance/talangan`).
- **Akuntansi**: COA, jurnal umum, neraca, laba rugi, arus kas, tutup buku (otomatis tgl 10 pukul 09.00 WIB), Atur saldo rekening, piutang/hutang/pinjaman + cicilan pokok & bunga, aset tetap.
- **Analitik & AI Advisor**, unduh Excel/CSV, unduh JPG dengan kop surat seragam (`DocSheet`).
- **Supplier** (detail + riwayat hutang, gabung supplier dobel) & **Pelanggan** (pembeli offline).
- **Bot Telegram ERP** (lihat bagian 7).
- **Backup** harian + salinan terenkripsi ke Telegram.

## 4. Aturan bisnis (wajib dijaga)

- **Gaji bulanan**: siklus dari tanggal masuk s/d sehari sebelum tanggal yang sama bulan depan; slip otomatis 06.00 saat siklus selesai; gajian = tanggal ulang bulan (anniversary) + 7 hari. Setting `go_live_date=2026-10-29`.
- Libur 1 hari per 7 hari; lebih = **bolos** (potong gaji ÷ 26 per hari). Izin/sakit memakai jatah yang sama. Resign sebelum gajian = Rp0. Absen yang belum divalidasi diberi peringatan di slip.
- **Kasbon** dipotong otomatis dari slip berikutnya, tampil di slip JPG. Pekerja borongan tidak dapat kasbon.
- **Borongan** dikerjakan tetangga (bukan karyawan). Tarif per pcs adalah total anggaran yang dibagi pekerja/koordinator/driver: cat giftbox 80/20/0, assembling 30/15/15, cat plastik 13/2/0 (total 100/60/15). Driver = CAK ED; bagian driver dibayar bersama pelunasan borongan sebagai baris upah sendiri, **jangan dicampur dengan Kompensasi Pengelola**. Bahan keluar dari gudang saat diserahkan, hasil yang disetor menambah stok setengah jadi.
- **Rekening**: Seabank 5984 = operasional; Seabank 0006 = tabungan cicilan hutang ("Nabung Bayar Hutang", Rp300rb/hari, satu dana untuk semua pinjaman); ShopeePay = simpanan kompensasi pengelola. Satu rekening aktif = satu akun COA.
- **Kompensasi Pengelola (Owner)**: Rp200rb/hari (Rp100rb CAK ED + Rp100rb Jojo), dibebankan dan disimpan di ShopeePay sampai diambil.
- **Dana talangan**: uang dari Seabank 0006/ShopeePay yang dipakai untuk transaksi/pembelian/gaji/kasbon/borongan wajib dikembalikan dari Seabank 5984 dengan bukti (mulai `talangan_mulai`=2026-11-01). Pengingat bot 08.00.
- **Toko** (Main Gypsum = MG, Dunia Lukis = DL) hanya membedakan **withdraw** dari saldo penjual marketplace. Beban & bahan baku dipakai bersama, laporan selalu gabungan. Withdraw dari Saldo Penjual otomatis mencatat pemasukan penjualan.
- **Biaya marketplace**: Shopee admin 8,25% + Gratis Ongkir Xtra 6%; TikTok komisi 9,5% + dinamis 8%; keduanya Rp1.250 per pesanan.
- Pinjaman lama yang sudah dicatat: Mas Rizal, SPinjam, Mbak Henny (PJM-202611-0001..0003).
- Transaksi yang sudah dibukukan **tidak pernah dihapus**: dibatalkan + jurnal balik.

## 5. Aturan tampilan & kode (preferensi user)

- Semua isian **Kode** dibuat otomatis (`autoCode` di `src/lib/codes.ts`), jangan pernah minta user mengetik kode.
- Pilihan ≤ 3 → tombol segmen; > 3 → dropdown yang bisa dicari (`ChoiceEnhancer`).
- Tabel biasa (bukan kartu) dengan paging 10 baris (`<Paged>`); kolom aksi menempel di kanan.
- Form tidak pernah terbuka di halaman: daftar + tombol Tambah/Ubah membuka `<Modal>` popup; menutup form yang terisi minta konfirmasi "Tutup form?".
- Kop surat (`DocSheet`) **hanya** untuk JPG, identik di semua dokumen; di layar tetap tabel biasa. JPG tanpa scrollbar, lebar tetap 1000px, ada pratinjau sebelum unduh.
- Mode malam (`data-theme="dark"`), kontras teks minimal 4,5:1. Bottom nav 5 menu prioritas per role.
- Setiap menu dengan sub-halaman punya `loading.tsx`. Popup baru memakai kelas `modal` + animasi tutup.
- Kategori barang/produk dibaca dari DB (tabel `ItemCategory`), bukan konstanta.
- Bot: `callback_data` Telegram maks 64 byte (id kategori dipendekkan 12 karakter terakhir).
- Pakai kata "Hutang" (bukan "Utang") di tampilan.

## 6. Deploy, update, staging

### Production
- Live di **https://erp.maingypsum.shop**, VPS milik user (Ubuntu 24.04, user `ubuntu`), Cloudflare proxied, SSL Full (strict), Nginx + certbot.
- Aplikasi di `~/main-gypsum-erp`, PM2: `maingypsum` (next start, 127.0.0.1:3000) dan `maingypsum-jadwal` (scheduler). DB PostgreSQL `maingypsum`. Backup cron harian 02.30 (14 hari + salinan terenkripsi ke Telegram).
- **Claude tidak bisa SSH ke VPS.** User sendiri yang menjalankan perintah lalu menempel hasilnya. Jangan pernah minta user menempel isi `.env`, password, atau token.

Perintah update production (setelah merge ke `main`):

```bash
cd ~/main-gypsum-erp && git pull origin main && npm run backup && npm ci && npx prisma migrate deploy && npm run build && pm2 restart maingypsum maingypsum-jadwal --update-env
```

### Staging
- **https://tes.maingypsum.shop**, folder `~/main-gypsum-erp-staging`, DB `maingypsum_staging`, PM2 `maingypsum-staging` (port 3001), tanpa scheduler, Telegram/cron mati, `APP_ENV=staging`, data = salinan production. Detail di `docs/STAGING.md`.
- Deploy branch ke staging: `bash ~/main-gypsum-erp/scripts/staging/deploy.sh <nama-branch>`
- Kembalikan staging ke main: `bash ~/main-gypsum-erp/scripts/staging/deploy.sh main`
- Ambil data production terbaru: `bash ~/main-gypsum-erp/scripts/staging/refresh-data.sh`

### Alur kerja wajib (aturan tetap dari user)
1. Setiap fitur/perbaikan di **branch sendiri + PR**, tidak pernah langsung ke `main`.
2. Balasan ke user selalu menyertakan perintah staging: `bash ~/main-gypsum-erp/scripts/staging/deploy.sh <branch>`.
3. User mengecek di tes.maingypsum.shop. Perbaikan masuk ke branch yang sama, user jalankan ulang `deploy.sh`.
4. **Merge ke `main` hanya setelah user bilang staging OK**, lalu berikan perintah update production (plus skrip data tambahan bila ada).
5. Setelah merge, staging boleh dikembalikan ke `main`.

(Beberapa kali user meminta merge tanpa tes staging; itu boleh bila user sendiri yang meminta.)

## 7. Bot Telegram

- ERP punya **bot sendiri** ("Main Gypsum ERP"), webhook ke `/api/telegram/webhook`.
- **Magy Bot (@Maingypsum_bot) milik Hermes AI Agent** (berjalan di VPS yang sama). **Jangan pernah memakai token Magy Bot di ERP**: pernah terjadi, `setWebhook` merusak polling Hermes. Cek identitas bot dengan `getMe`, bukan dari nama file.
- Hermes memakai skill `maingypsum-finance` yang memanggil `/api/v1` dengan API key ber-scope draft. Status: gateway Hermes sendiri belum membalas (belum terselesaikan, di luar repo).
- Fitur bot: `/menu` tombol per role, ringkasan, unduh laporan JPG, catat transaksi dari teks/foto (AI → OCR cadangan, batas 35 dtk/20 dtk), kenali pembelian bahan baku, angsuran hutang/cicilan pinjaman, transfer sisihan + bukti, withdraw MG/DL, rincian multi-kategori, deteksi duplikat, absen lokasi, input produksi, stok, kasbon, pembelian, borongan, dana talangan, ganti rekening/kategori/toko di kartu draft. `/rekap` dibatasi izin.
- Error bot tersimpan di `NotificationLog` (type WEBHOOK, status GAGAL), bukan di log pm2.
- Untuk tes bot di staging perlu bot tes terpisah dari BotFather.

## 8. AI

- User **tidak punya kartu kredit**, jadi memakai **KelontongAI** (OpenAI-compatible): `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (claude-haiku-5.5), `AI_MODEL_FALLBACK` (daftar model cadangan, dipisah koma) di `.env` VPS.
- Dipakai untuk baca foto bukti dan AI Advisor. Bila kuota habis (pernah: HTTP 400 `model_tokens_exhausted`), bot jatuh ke OCR server.

## 9. Skrip perbaikan data (semua: jalankan dulu tanpa flag = pratinjau, lalu `-- --jalankan`)

| Perintah | Fungsi | Status |
|---|---|---|
| `npm run setup:divisi` | divisi & bahan baku dari contoh laporan shift | sudah |
| `npm run cek:password` | cek akun yang masih memakai password default | sebaiknya dicek lagi |
| `npm run kosongkan` (`-- --hapus`) | kosongkan data transaksi untuk mulai bersih | sudah dipakai 3 Nov |
| `npm run rapikan:kode` | ubah kode lama ke format otomatis | sudah |
| `npm run pisahkan:rekening` | 1 rekening = 1 COA | sudah |
| `npm run withdraw:pemasukan` | withdraw lama → pemasukan penjualan | dijalankan user |
| `npm run rapikan:hutang -- --data=/tmp/pinjaman.json` | catat pinjaman lama (JSON di luar repo) | sudah |
| `npm run satukan:supplier -- --gabung="Supplier BG Klip Label" --ke="Afdhol Grafika"` | gabung supplier dobel | sudah |
| `npm run sinkron:sisihan` (`--pilih=TRX:k`, `--lewati=TRX`) | sinkron transfer lama ↔ dana sisihan | sudah |
| `npm run tautkan:transaksi` | tautkan uang rekening lama dari menu lain (pembelian, gaji, kasbon, borongan, sisihan, penjualan, pinjaman, piutang, aset) ke menu Transaksi sebagai baris tertaut; tanpa jurnal baru, saldo tidak berubah, aman diulang | dijalankan user setelah PR #60 |
| `npm run backup` / `restore` / `backup:buka` | backup & pulihkan | rutin |

Skrip dari PR #38 (sudah merge): `audit:saldo`, `scripts/koreksi-saldo-nov.ts`, `scripts/koreksi-transaksi-nov.ts`, `scripts/catat-bunga.ts`.

## 10. Riwayat PR penting

| PR | Isi |
|---|---|
| #1–#3 | ERP awal, patch keamanan Next.js, aturan bisnis gaji/borongan/kasbon/pembelian/sisihan |
| #8, #13–#15, #17 | bottom nav, mode malam, tabel + popup form, Supplier/Pelanggan, kop surat JPG, menu profil, notifikasi |
| #10 | laporan penutup shift per divisi, role Supervisor |
| #11 | tunjangan tgl 15, Atur saldo rekening, go-live date, HPP sak→gram |
| #12 | absen GPS geofence |
| #16 | perbaikan audit 29 Okt |
| #18 | staging tes.maingypsum.shop |
| #19–#21 | form tahap 1 (OCR bukti), borongan tetangga, HPP/resep/overhead/harga |
| #22 | aturan toko, JPG tanpa scrollbar |
| #24 | laba/reject per produk, unduh Excel, backup offsite Telegram |
| #25, #27, #28 | bot Telegram menu tombol + JPG, input produksi/absen/stok, kasbon/pembelian/borongan |
| #26 | skrip kosongkan data |
| #29 | kode otomatis |
| #30 | OCR server cadangan di bot |
| #31–#34 | menu Transaksi, batalkan & hapus transaksi, 1 COA per rekening, bot pembelian/angsuran/sisihan/withdraw |
| #35 | hutang & pinjaman (COA, pinjaman lama, cicilan pokok+bunga) |
| #36, #37 | bot selalu membalas saat gagal, ubah rekening transaksi dibukukan |
| #39, #40 | perbaikan audit 8 Nov paket 1, 2, 3 |
| #41 | tombol Kategori bot, kategori Konsumsi & Perawatan |
| #42 | gabung supplier, sinkron transfer ↔ sisihan, dana talangan |

## 11. Pekerjaan terbuka

1. **Audit saldo November** (PR #38 sudah di-merge). Sisa: Seabank 0006 diperkirakan ~290rb lebih tinggi dari saldo asli, menunggu mutasi 0006 tanggal 1–5 Nov dari user; TRX-202611-0061 (WD TikTok MG 684.934) perlu dibatalkan & dicatat ulang tgl 5 Nov; perlu akun COA "Retur & Refund Penjualan". Laporan: `/mnt/project-files/audit-saldo/rekonsiliasi-2026-11-05.md` (folder proyek lama). Putuskan bersama user: merge, atau tutup.
2. ~~Setelah PR #42~~: `satukan:supplier` dan `sinkron:sisihan` sudah dijalankan user di production.
3. **Temuan audit 8 Nov yang belum dikerjakan**:
   - **S9** keamanan login: kunci akun 5x gagal bisa dipakai orang lain untuk mengunci akun (DoS), belum ada batas per IP, sesi lama tidak dicabut saat ganti password. Saran: rate limit per IP (+ Cloudflare rate limit `/login`), versi sesi di User untuk mencabut sesi.
   - **S10** lokasi GPS dipercaya dari browser/Telegram; staging publik berisi salinan data production (saran: lindungi staging dengan Cloudflare Access/basic auth).
   - **R3** hapus produksi tidak mengembalikan harga pokok rata-rata (avgCost); `addResults` tidak atomik.
   - **R4** cek stok rawan race condition, beberapa query scan penuh.
   - **R5** `npm audit`: postcss, zod, deepmerge-ts perlu diperbarui.
   - **R6** token bot terlihat di argumen `curl` dalam `scripts/backup.sh` (pakai file config / stdin).
   - Laporan audit lengkap ada di akun Claude lama (artifact, tidak bisa dibuka dari akun lain).
4. **Belum ada modul Penjualan** (order offline per toko, piutang pelanggan, stok barang jadi keluar per penjualan). Saat ini HPP lewat opname barang jadi akhir bulan. Kandidat fitur besar berikutnya bila user mau.
5. Usulan lama yang belum dipilih: anggaran beban bulanan per kategori dengan peringatan; rotasi API key KelontongAI.
6. Di luar repo: gateway Hermes belum membalas.

## 12. Preferensi user

- Selalu berbahasa **Indonesia**, kalimat sederhana.
- Bila ada yang ambigu, tanyakan dengan **pilihan/opsi tombol** (pertanyaan pilihan ganda), sertakan rekomendasi.
- User bukan programmer: berikan perintah lengkap siap tempel untuk VPS, satu blok per langkah.
- Jangan minta rahasia di chat. Tanyakan dulu sebelum langkah yang tidak bisa dibatalkan (hapus data production, dll.).
- Ikuti alur branch → staging → OK → merge (bagian 6).

## 13. Cara kerja koordinator + utas (mulai 8 Nov 2026)

- Satu sesi Claude menjadi **koordinator**; setiap tugas dikerjakan di **sesi/utas sendiri** dengan branch + PR sendiri.
- Setiap utas: kerjakan di branch-nya, jalankan `npm run typecheck` dan tes terkait, push, buat PR (draft boleh), lalu laporkan ke koordinator: nomor PR, ringkasan, perintah staging, dan skrip data tambahan bila ada.
- Bila butuh keputusan/data dari user, utas bertanya ke koordinator (koordinator yang meneruskan ke user dengan pilihan tombol).
- Staging hanya satu (tes.maingypsum.shop), jadi user menguji branch satu per satu. Koordinator yang mengatur urutannya.
- Hindari mengubah file yang sama dengan utas lain; bila tidak bisa, beri tahu koordinator.
