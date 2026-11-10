# Serah-terima proyek Main Gypsum ERP

Prompt pembuka untuk akun/sesi Claude baru ada di [PROMPT-PEMBUKA.md](PROMPT-PEMBUKA.md).

Dokumen ini merangkum semua yang perlu diketahui untuk melanjutkan pengembangan ERP Main Gypsum di akun atau sesi Claude lain. Posisi per **10 November 2026**, kode di `main` sampai **PR #73** (commit `25fed0a`). Tidak ada PR terbuka.

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
- **Penjualan offline** (`/penjualan`, #50): nota JUAL-…, banyak barang, diskon per nota, ongkir (4-1300), lunas/sebagian/tempo → piutang + cicilan berbukti, stok barang jadi keluar + HPP langsung (avgCost; bila 0 pakai bahan+kemasan resep, #72), nota JPG.
- **Anggaran beban** per akun COA (`/akuntansi/anggaran`, #48), peringatan 80%/100% di Beranda + bot Owner 08.00.
- **Piutang Pengelola** (#55): pinjaman pengelola dari ShopeePay/0006 (akun 1-1320) + pengembaliannya, ikut Dana talangan & pengingat 08.00.
- **WD TikTok "Dalam Proses"** (#63, #69): pendapatan diakui di tanggal pengajuan ke akun **Dana dalam Perjalanan**, uang masuk Seabank 5984 saat "Uang diterima" (wajib bukti). Screenshot TikTok Seller Center "Detail penarikan dana" dibaca otomatis: bila sudah "Berhasil ditransfer" langsung Dibukukan; No. Referensi = cek duplikat. Tab Dalam Proses, kartu + popup di Beranda.
- **Cek saldo pagi** (#63, #65, #67): 05.00 WIB bot kirim saldo tiap rekening ke Jojo + semua Owner (+ grup terdaftar), tombol Sesuai/Tidak sesuai → saldo bank + mutasi; pengingat 12.00; riwayat di Transaksi → Cek saldo harian.
- **Semua uang rekening tampil di Transaksi** (#60): pembelian, gaji, kasbon, borongan, sisihan, penjualan, pinjaman, aset = baris tertaut (hanya-baca, "Buka menu …"), jurnal tetap satu.
- **Daftar Transaksi ringan** (#68): satu tabel 10 baris/halaman, 50 transaksi terbaru + "Tampilkan lebih lama", Unduh Excel dari server (`/finance/export`). Filter diingat per halaman saat kembali dari halaman lain + tombol Reset filter (#62, #64). Tab Ditolak/Dibatalkan bisa "Tampilkan yang disembunyikan" (#52).
- **Login** (#47, #58): batas percobaan per IP, kunci bertahap, sesi dicabut saat ganti password, ikon mata, lupa password via Gmail SMTP, Masuk dengan Google (hanya akun yang emailnya terdaftar).
- **PWA** (#70): bisa dipasang di Android/iPhone (Profil → Pasang aplikasi), layar penuh, pintasan, halaman offline; data keuangan tidak disimpan di HP. Staging bernama "MG ERP (Tes)".
- **Foto bukti dikompres** saat diunggah (#71, sharp; maks 1600/2000 px, EXIF/GPS dibuang, PDF tetap); batas unggah 15 MB.
- **Akuntansi** (#72): tombol Balik hanya untuk jurnal MANUAL/PENYESUAIAN/SALDO_AWAL (jurnal lain → "Buka sumber"), arus kas selalu klop (kelompok ke-4 "Penyesuaian saldo & saldo awal rekening" + tanda ✓), Jurnal umum ringkas (Akun | Debit | Kredit), pemakaian bahan laporan shift → akun HPP "Pemakaian Bahan Baku", tutup buku otomatis juga menutup bulan lama, tipe akun COA dikunci bila sudah ada jurnal, form Aset: tanggal < go-live otomatis "Saldo awal (aset lama)".
- **Kategori**: Bahan Pesanan Custom (5-1100), Langganan Software & AI (6-1550), Retur & Refund Penjualan (4-1200), Bunga Bank (4-9100), Pajak Bunga Bank (6-1960).
- **Bot Telegram ERP** (lihat bagian 7), termasuk **grup Telegram** terdaftar.
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
- **WD TikTok** selalu masuk ke **Seabank 5984** (setting `wd_tiktok_rekening`). Tahap "Berhasil ditransfer" di Seller Center = uang sudah masuk SeaBank (jam itu = jam terima).
- **Sisihan berbukti dari bot**: caption "OPS <tgl>" = transfer Kompensasi Pengelola 5984 → ShopeePay; "Nabung SPinjam <tgl>" = transfer Nabung Bayar Hutang 5984 → 0006. Sisihan otomatis tanggal itu diserap (Dibatalkan) agar tidak dobel.
- **Pinjaman pengelola** (mis. "Edy pinjam dana OPS") = Piutang Pengelola, bukan beban dan bukan bayar hutang.
- **Aset/kejadian sebelum go-live (29 Okt 2026)** dicatat dengan lawan **3-9000 Ekuitas Saldo Awal**, BUKAN dari rekening (saldo rekening awal sudah diatur 1–4 Nov). Contoh: Mesin Oven (Mei, Rp18,5jt, 48 bln) & Sewa Rumah Produksi (Juni, Rp14jt, kontrak 12 bln) — sudah dikoreksi dengan `koreksi:aset-sumber-dana`.
- **Barang diterima tapi belum dibayar** dicatat lewat Stok → Pembelian dengan Nominal bayar 0 (Hutang), bukan sebagai uang keluar di Transaksi.
- **Bunga tabungan** = pemasukan kategori Bunga Bank; potongan pajak bunga = Pajak Bunga Bank.
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
- User punya 2 server di aplikasi terminal: **"VPS magy" (`VM-18-187`) = ERP + Hermes**, dan "Server Cak Ed" (`VM-14-243`, bukan ERP). Bila perintah gagal "No such file or directory", cek tab server-nya.
- **Firewall (ufw) aktif**: 22/tcp terbuka, 80/443 hanya dari IP Cloudflare. Rate limit Cloudflare untuk `/login` disarankan (belum dipastikan terpasang).
- Log systemd dibatasi 300 MB (`/etc/systemd/journald.conf.d/batas.conf`). Disk ±59 GB (sisa ±31 GB per 10 Nov). RAM 3,6 GB (Hermes ±350 MB); staging sebaiknya dimatikan saat tidak dites: `pm2 stop maingypsum-staging && pm2 save` (otomatis hidup lagi saat `deploy.sh`).
- `.env` production juga berisi `SMTP_*`, `MAIL_FROM`, `GOOGLE_CLIENT_ID/SECRET`, `APP_URL` (lupa password & login Google). Google OAuth app berstatus Testing → Gmail pengguna harus didaftarkan di Google Cloud → Audience → Test users.

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
- Tambahan sejak 9 Nov: penjualan + cicilan piutang + pengingat jatuh tempo (#53); tombol draft "❌ Tolak" (draft dibuang = status Ditolak, #51); cek transaksi mirip di semua alur dengan kartu "Berbeda, tetap simpan / Sama, jangan simpan / Lihat transaksi lama", saran kategori 1–3 tombol + usul kategori baru (disetujui Owner/Finance), isian kedaluwarsa bisa "Lanjutkan", setiap error ada Coba lagi/Batal (#60); konfirmasi tanggal WD (#56); WD TikTok dari screenshot Seller Center (#69); OPS/Nabung SPinjam (#66); bunga bank (#73); pinjaman pengelola (#55).
- **Grup Telegram** (#67): grup harus didaftarkan Owner dengan `/daftargrup` (cabut `/hapusgrup`); privacy mode bot di BotFather harus **Disable**. Isian per orang (kunci sesi `chatId:userId`), bot membalas ke pesan pengirim, tombol kartu orang lain ditolak (kecuali Owner/Finance), obrolan tanpa nominal/foto diabaikan, pesan grup tidak diteruskan ke Hermes. Pengingat (cek saldo 05.00/12.00, WD 08.00) juga ke grup — `/pengingatgrup` untuk mematikan; `/rekapgrup` untuk rekap harian. Grup production: "Laporan Magy" (pastikan sudah `/daftargrup` dan akun Telegram yang dipakai Owner di grup sudah ditautkan di Pengaturan → Telegram & Hermes).
- Jadwal bot: 05.00 cek saldo, 08.00 pengingat talangan/WD dalam proses/piutang jatuh tempo/anggaran, 12.00 pengingat cek saldo.
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
| `npm run koreksi:wd-0061` | koreksi tanggal TRX-202611-0061 | sudah (oleh skrip #38) |
| `npm run koreksi:saldo-0006-balik` | balik koreksi lama 0006 + penyesuaian Rp9.878 | sudah (9 Nov) |
| `npm run koreksi:tanggal-wd` / `koreksi:saldo-5984` | tanggal 8 WD sesuai jam masuk SeaBank; bunga, dobel, Shopee 2 Nov | sudah (9 Nov) |
| `npm run kompres:file` (`-- --dir=…`) | kompres foto lama di STORAGE_DIR (path tetap) | sudah (10 Nov; 118 file 5,7 MB, sudah kecil) |
| `npm run koreksi:aset-sumber-dana -- --jurnal=JU-202605-0002,JU-202606-0001` | aset lama: kredit bank → Ekuitas Saldo Awal, Sewa 12 bulan, penyusutan susulan | dijalankan user setelah #72 (cek!) |
| `npm run audit:saldo -- --asli=5984:ANGKA` | audit saldo rekening vs bank (baca-saja) | alat rutin |
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
| #43 | (ditutup tanpa merge: dokumen serah-terima versi akun lama) |
| #44 | dropdown cari melebar |
| #45 | perbarui zod/postcss/deepmerge-ts, rahasia tidak di argumen perintah |
| #46 | akun Retur & Refund 4-1200, koreksi TRX-0061 |
| #47 | keamanan login (batas per IP, kunci bertahap, cabut sesi) |
| #48 | anggaran beban bulanan |
| #49 | stok & produksi atomik (avgCost, kunci baris) |
| #50, #53 | modul Penjualan (web) + Penjualan lewat bot |
| #51, #52 | bot "Tolak", tampilkan transaksi yang disembunyikan |
| #54, #56 | koreksi saldo Seabank 0006 & 5984, tanggal WD |
| #55 | Piutang Pengelola, tandai pengembalian talangan, ShopeePay ≠ Saldo Penjual |
| #57 | kategori Bahan Pesanan Custom & Langganan Software & AI |
| #58 | login: ikon mata, lupa password Gmail, login Google |
| #59 | audit:saldo tanpa alarm palsu |
| #60, #61 | cek transaksi mirip, saran kategori, baris tertaut di Transaksi, skrip tautkan:transaksi |
| #62, #64 | dropdown HP, filter diingat + Reset filter |
| #63, #65 | WD TikTok Dalam Proses (Dana dalam Perjalanan), cek saldo pagi (Jojo + Owner) |
| #66 | bot OPS/Nabung SPinjam → transfer sisihan |
| #67 | bot di grup Telegram + pengingat ke grup |
| #68 | daftar Transaksi ringan (50 baris, export server) |
| #69 | WD TikTok otomatis dari screenshot Seller Center |
| #70 | PWA |
| #71 | kompres foto bukti |
| #72 | audit Akuntansi (Balik dikunci, arus kas klop, Jurnal ringkas, HPP pemakaian bahan, tutup bulan lama, koreksi aset) |
| #73 | kategori Bunga Bank & Pajak Bunga Bank, bot mengenali resi bunga |

## 11. Pekerjaan terbuka (per 10 Nov 2026)

1. **Pastikan langkah production terakhir sudah dijalankan user**: update ke `main` (#72, #73) → `koreksi:aset-sumber-dana` (pratinjau lalu `--jalankan`) → tutup lagi bulan Mei/Juni (dan Oktober bila dibuka). Lalu cek saldo Seabank 5984 di ERP = saldo aplikasi SeaBank (setelah bunga 10 Nov dan 2 WD TikTok 10 Nov ditandai "Uang diterima").
2. **Grup Telegram "Laporan Magy"**: tautkan akun Telegram yang dipakai Owner di grup, BotFather `/setprivacy` → Disable, keluarkan-masukkan bot, `/daftargrup`.
3. **Sisa audit Akuntansi (#72)**: S4 rekonsiliasi piutang/hutang vs akun + aset dibeli dengan hutang belum membuat dokumen Payable; S5 pembelian peralatan lewat Transaksi tidak jadi FixedAsset (tidak disusutkan); R2 Atur saldo diposting 12.00 (sebaiknya 23.59); R3 daftar akun pinjaman terlalu luas. Penyusutan Oktober aset lama dibukukan sebagai "(susulan)" di November bila Oktober tidak dibuka saat skrip dijalankan.
4. **HPP**: opname barang jadi akhir bulan masih menjadi sumber HPP penjualan marketplace; pastikan user melakukannya tiap akhir bulan. Harga pokok barang jadi masih banyak 0 → isi resep di Produk & HPP / input produksi tahap Barang Jadi.
5. **Keamanan**: Cloudflare rate limit `/login` (langkah klik demi klik sudah pernah diberikan); S10 staging publik berisi salinan data production (saran Cloudflare Access/basic auth); `npm audit` sisa vitest (dev only).
6. **Tampilan** (pratinjau 10 Nov, user hanya memilih Jurnal ringkas): menu Akuntansi ringkas berkelompok & tabel laporan rapat (kode di bawah nama akun) belum diterapkan.
7. Folder lama di VPS yang dibiarkan atas permintaan user: `~/main-gypsum-v101` (ekspor kode lama), `~/ruang` (proyek lain), `~/main-gypsum-migration-20261008`.
8. Usulan lama: rotasi API key KelontongAI; gateway Hermes belum membalas (di luar repo).

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
- Koordinator memverifikasi setiap PR sendiri sebelum merge (typecheck + `npm test` minimal 2x dengan Postgres lokal; gabungan dengan `main` terbaru), lalu merge (squash) setelah user bilang "staging OK" atau "merge #N", dan memberi perintah production. Utas tidak boleh merge.
- Fitur bot tidak bisa dites di staging (Telegram mati); biasanya langsung merge atas izin user lalu dicoba di production.
- Saat staging hanya satu dan ada banyak PR, tes bergantian; setiap ganti PR yang bermigrasi, jalankan `refresh-data.sh` dulu.
- Utas yang pernah dibuka (sesi Claude Code Remote, tag `main-gypsum-erp:utas`): A keamanan login, B stok & produksi, C paket & backup, D audit saldo + piutang pengelola + kategori, E Penjualan, F Anggaran, G bot penjualan, H login Google/reset, I bot (duplikat, kategori, grup, OPS, bunga), J WD Dalam Proses + cek saldo, K PWA, L kompres foto, M audit Akuntansi. Semua PR-nya sudah di-merge.

## 14. Kondisi data per 10–11 Nov 2026

- Saldo Seabank 0006 dan ShopeePay sudah dicocokkan dengan aplikasi (selisih 0 per 9 Nov); Seabank 5984 dicocokkan ulang 10–11 Nov (lihat bagian 11 no. 1). Angka persis selalu diambil dari VPS/aplikasi bank saat itu, tidak dicatat di repo.
- Masih ada talangan terbuka (plastik klip dari Seabank 0006) dan pinjaman pengelola dari ShopeePay; lihat Transaksi → Dana talangan.
- Ada hutang usaha baru dari pembelian tempo 10 Nov; lihat Akuntansi → Piutang & hutang.
- Periode: Oktober ditutup otomatis 10 Nov 09.00; Mei/Juni pernah dibuka user untuk aset lama (tutup lagi). Tutup otomatis berikutnya 10 Des (ikut menutup bulan lama yang masih terbuka).
