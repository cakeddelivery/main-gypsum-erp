# Audit integrasi menu (laporan, tanpa perubahan kode)

Tanggal: 19 Nov 2026 · basis: `main` setelah #139/#140 (+ PR terbuka #141–#146 bila disebut).
Cara: daftar semua halaman (`src/app/**/page.tsx` = 92 rute), menu samping/bawah (`src/lib/nav.ts`), portal koordinator/driver, bot Telegram (`src/lib/bot*.ts`), lalu telusur kode: tautan masuk/keluar tiap halaman, dan tabel mana yang dibaca/ditulis oleh modul lain.
Batas: analisis statis (kode + tautan), belum dicoba satu per satu di staging. Baris bertanda **(cek)** perlu dikonfirmasi pengguna harian sebelum bertindak.

Prioritas: **P1** = data salah/bertentangan sekarang atau input ganda berisiko; **P2** = membingungkan/duplikat tetapi tidak merusak angka; **P3** = kerapian.

## A. Alur produksi & stok (paling penting karena cut-over 1 Des)

| Menu | Masalah | Dampak | Usulan | Prioritas |
|---|---|---|---|---|
| Dashboard (`/`), kartu "Input hasil" | Angka produksi hari ini dibaca dari tabel `ProductionEntry` (input manual lama), bukan dari Laporan Shift. Tautan "Input hasil" (`/produksi?baru=1`) masih mengundang input manual. | Setelah cut-over, dashboard menunjukkan 0/ketinggalan padahal laporan shift sudah terkirim; orang tergoda mengetik ulang. | Dashboard memakai `alurProduksi()` (PR #146) untuk hasil/reject per tahap; tombol "Input hasil" dihapus atau jadi tautan ke Laporan Shift. | P1 |
| Rekap harian Telegram 07.00 (`jobs.ts` `dailyRecapText`) | Total produksi & barang jadi dari `ProductionEntry`. | Rekap pagi bisa 0 / tidak sama dengan laporan shift; owner membaca angka berbeda dari Laporan. | Ganti sumber ke laporan shift + borongan (fungsi yang sama dengan Alur Produksi). | P1 |
| Laba produk (`/produk/laba`, `productProfit.ts`) | Produksi/reject/pekerja per produk dari `ProductionEntry`. | Laba & reject per produk tidak ikut hasil laporan shift (tidak ada per-produk di laporan, hanya per karakter/SKU katalog). | Hitung reject dari `ProductionReject` + hasil dari `ShiftBalance`/`flowItem`; sampai itu siap, beri label "data input manual". | P1 |
| Bot Telegram, alur input hasil (`botFlow.ts` → `recordProductionEntry`) | Bot masih mencatat hasil sebagai `ProductionEntry`. Setelah sakelar menyala, non-Owner ditolak, tetapi menunya masih tampil. | Operator mencoba input via bot, ditolak; sebelum sakelar menyala justru terjadi input ganda dengan laporan. | Sembunyikan menu "hasil produksi" di bot bila sakelar `laporan_shift_ke_stok` menyala; arahkan ke "Buka laporan shift". | P1 |
| Gaji harian (`payroll.ts` ~baris 288) | Slip harian membaca `ProductionEntry` per karyawan (bonus/produksi). | Karyawan yang hasilnya hanya ada di Laporan Shift tidak terhitung; sebaliknya input manual Owner bisa menambah. | Pastikan komponen gaji hanya memakai absensi (+ borongan). Bila bonus produksi dipakai, ambil dari laporan shift per karyawan. **(cek)** apakah komponen itu masih dipakai. | P2 |
| Produksi › Target (`/produksi/target`) | Target per divisi/karyawan terpisah dari target di laporan shift (`targetPerShift` di Divisi). | Dua tempat mengatur target; capaian % di laporan mengikuti Divisi, bukan halaman Target. | Satukan: halaman Target mengedit `targetPerShift`/target karyawan dan laporan membacanya. **(cek)** | P2 |
| Produksi (`/produksi`) tabel entri manual | Tabel input manual masih berdampingan dengan alur baru. | Pengguna menganggapnya sumber utama. | Sudah dilabeli "Koreksi manual" dan "+ Koreksi (Owner)" di PR #146; setelah 1 Des pertimbangkan memindahkannya ke Stok › Mutasi (penyesuaian) dan menghapus menu. | P2 |
| Stok › Mutasi (`/stok/mutasi`) | Penerimaan/pengeluaran/transfer/penyesuaian manual bisa dibuat untuk barang yang juga diposting otomatis dari laporan shift/borongan. | Risiko mutasi ganda untuk barang yang sama (kecuali Owner yang sengaja mengoreksi). | Tampilkan peringatan/blokir mutasi manual pada barang otomatis (patung cetak/kering, barang jadi) untuk non-Owner setelah cut-over. | P1 |
| Stok › Opname barang jadi (`/stok/opname`) vs stok akhir di laporan shift vs `/stok/cutover` vs `/stok/awal` | Tiga/empat tempat menghitung/mengatur stok awal & hasil hitung fisik: Opname, Stok awal, Cut-over (daftar hitung), kolom "stok akhir" di laporan shift. | Angka hitung fisik bisa diketik di beberapa tempat; selisih terlihat di `/stok/selisih` yang tidak punya menu. | Jadikan satu "Hitung fisik": laporan shift (harian, per divisi) + Cut-over (satu kali) ; Opname bulanan hanya Owner. Tautkan `/stok/selisih` dari menu Stok. | P2 |
| Barang masuk: Laporan shift (`ShiftReceipt`) vs Stok › Pembelian vs Permintaan stok | Tiga pintu barang masuk. Sudah terhubung (`pendingDeliveries` memasangkan penerimaan laporan ke pesanan), tetapi barang tanpa pesanan bisa tercatat tanpa pembelian. | Stok naik tanpa hutang/jurnal sampai Finance memasangkan. | Tambahkan daftar "Barang masuk belum dipasangkan" di Stok › Pembelian dengan penanda umur; sudah ada data, tinggal tampilannya. | P2 |
| Laporan › Bahan, Order, Standar, Kebocoran, Monitoring, Rekap, Sample (7 halaman) | Banyak halaman turunan dari tombol di `/laporan`; tiga di antaranya (Kebocoran, Standar, Stok/selisih) memeriksa hal serupa (selisih/pemakaian). | Pengguna bingung memilih mana; masalah yang sama terlihat di tiga tempat. | Gabungkan Kebocoran + Standar + Stok/Selisih jadi satu "Pemantauan stok" dengan tab; Monitoring + Rekap jadi satu "Rekap" dengan tab. | P2 |

## B. Borongan, gaji, dan uang

| Menu | Masalah | Dampak | Usulan | Prioritas |
|---|---|---|---|---|
| Gaji › Borongan & klaim (`/gaji/borongan`, `PieceWork` + `claimPieces`) vs Borongan › Klaim Upah (`BoronganClaim`) | Dua alur klaim upah borongan: yang lama (per karyawan, `PieceWork`) dan yang baru (per titik, 7× setoran). | Upah bisa tercatat/dibayar dua kali atau dilihat di dua tempat. | Tandai alur lama read-only; migrasi data lama; hapus menu setelah semua klaim lama dibayar. **(cek)** apakah `PieceWork` masih dipakai. | P1 |
| Gaji › Tarif borongan (`/gaji/tarif`) vs Tugas di Borongan vs tarif di Resep HPP | Tarif per piece ada di `PieceTask` dan diubah dari beberapa halaman. Resep sekarang hanya membaca (PR #136) — baik — tetapi Gaji › Tarif dan Borongan › Tugas sama-sama mengeditnya. | Dua tempat edit tarif. | Satu tempat edit (Borongan › Tugas); Gaji › Tarif hanya tautan. | P2 |
| Gaji › Kasbon vs Finance › Talangan vs Finance › Sisihan | Tiga konsep pinjaman/dana (kasbon karyawan, dana talangan owner, dana sisihan) di menu berbeda dengan istilah mirip. | Salah catat jenis; laporan hutang tersebar. | Satu halaman "Pinjaman & talangan" dengan tab; samakan istilah ("Hutang"). | P2 |
| Karyawan › Pendaftaran vs Pengaturan › Pengguna vs Karyawan (master) | Data orang di tiga tempat: pendaftaran (calon), master karyawan, akun pengguna. Divisi ada di Karyawan dan di User (`divisionId` cadangan). | Divisi akun bisa berbeda dari divisi karyawan (sudah ada aturan "data karyawan menang", tapi dua kolom tetap ada). | Hapus `User.divisionId` bila semua akun operasional tertaut ke karyawan; tampilkan tautan akun di kartu karyawan. **(cek)** | P2 |
| Kontrak kerja (#141) vs Karyawan (gaji pokok, tunjangan) | Gaji pokok & tunjangan ada di master karyawan dan di kontrak (snapshot). Perubahan master tidak mengubah kontrak (memang disengaja), tetapi tidak ada peringatan bila berbeda. | Slip "Gaji saya" memakai kontrak, penggajian memakai master → angka bisa beda. | Tambah tanda "berbeda dari kontrak" di Karyawan dan pengingat membuat addendum. | P2 |
| Akuntansi › Saldo awal, Atur saldo rekening vs Finance › Mutasi/Cek saldo | Saldo rekening diatur/dikoreksi di Akuntansi, dilihat di Finance, dicek harian lewat Cek saldo. | Tiga halaman untuk satu angka; koreksi bisa luput dari cek harian. | Tautkan saling (di Cek saldo: "Atur saldo"), satu bagian "Rekening" di Finance. | P3 |

## C. Penjualan, retur, marketplace, produk

| Menu | Masalah | Dampak | Usulan | Prioritas |
|---|---|---|---|---|
| Penjualan (hanya offline) vs Akuntansi › Marketplace vs Retur | Marketplace tidak ada di Penjualan (pendapatan dari withdraw, HPP dari opname bulanan), sehingga invoice marketplace (#143) harus manual dan "penjualan per channel" tidak ada. | Laporan penjualan hanya sebagian omzet; invoice marketplace diketik ulang. | Impor/rekap pesanan marketplace (sudah ada `MarketplaceSkuMap`) menjadi baris Penjualan channel TTS/SHP (tanpa data pembeli). | P1 |
| Retur › Komplain vs Retur › Analitik vs Akuntansi (refund) | Alur retur → klaim → refund → jurnal tersebar di 3 menu; `retur/analitik` tidak punya tautan dari menu lain selain halaman Retur. | Sulit melacak satu kasus end-to-end. | Garis waktu kasus di detail retur (retur → klaim → refund → jurnal). | P3 |
| Produk & HPP: Induk, Setengah jadi, Biaya, Overhead, Laba (+ Stok › Master) | Master barang ganda: `Item` (stok) dan `Product` (harga/HPP) dihubungkan lewat `finishedItemId`; barang bisa dibuat di dua tempat. | Barang tanpa produk (atau sebaliknya) → HPP 0 / harga kosong (invoice juga butuh harga channel). | Satu "Katalog" yang membuat Item+Product bersamaan; Stok › Master hanya untuk bahan baku. Sudah ada skrip `setup:produk-hpp` untuk menambal. | P2 |
| Produk › Biaya & Overhead | Halaman terpisah dengan judul sama ("Produk & HPP"), tidak jelas bedanya di tab. | Salah mengedit. | Beri judul halaman yang berbeda. | P3 |

## D. Navigasi, portal, bot

| Menu | Masalah | Dampak | Usulan | Prioritas |
|---|---|---|---|---|
| `/stok/selisih` | Tidak ada satu pun tautan masuk (halaman yatim). | Fitur cek selisih stok tidak ditemukan pengguna. | Tautkan dari Stok dan dari kartu Cut-over; atau gabungkan ke "Pemantauan stok". | P1 |
| `/finance/baru`, `/profil/panduan` | Hanya pengalihan/halaman yatim (tidak ada tautan masuk selain adresnya sendiri). `/finance/baru` hanya `redirect("/finance?baru=1")`. | Rute mati yang menambah beban perawatan. | Hapus `/finance/baru` (pakai tautan langsung `?baru=1`); `/profil/panduan` tautkan dari Profil atau hapus. | P3 |
| `/retur/[id]/klaim` | Hanya terhubung lewat tombol "Laporan klaim" di detail retur (sah), terdeteksi yatim karena tautan memakai template string. Tidak masalah. | — | Tidak perlu tindakan. | — |
| Kontrak kerja (#141) & Invoice (#143) di menu samping | Menu baru ("Kontrak kerja") tampil untuk semua orang yang punya `payroll.self`; Invoice hanya tombol di Penjualan. | Menu samping makin panjang; invoice sulit ditemukan. | Pindahkan "Kontrak kerja" ke Profil/Gaji saya untuk karyawan biasa; HRD saja yang melihat menu. Beri tautan "Invoice" di menu Penjualan. | P3 |
| Portal koordinator & driver | Portal hanya Borongan (sesuai desain). Pengingat push (#140: jadwal/libur) tidak berlaku untuk koordinator/driver yang bukan karyawan tertaut. | Koordinator tidak menerima pengingat. | Bila perlu, tautkan akun koordinator ke karyawan atau buat pengingat khusus portal. **(cek)** | P3 |
| Bot Telegram: penjualan (`botSales`), pembelian (`botPurchase`), WD (`botWd`), gaji (`botGaji`), draf transaksi | Bot dan web memakai fungsi inti yang sama untuk keuangan (baik), tetapi alur bot untuk produksi masih jalur lama (lihat A). Beberapa perintah (`/rekap`, `/ringkasan`) memakai sumber rekap yang sama dengan job 07.00 (A). | Angka bot ≠ angka layar. | Sama dengan usulan A; setelah rekap diganti, semua perintah ikut benar. | P1 |
| Dua pengingat berbeda arti (Push 12.00/15.00 "barang masuk/setoran" vs push shift #140) | Dua sistem pengingat (`pushReminders.ts`, `shiftReminders.ts`) dengan dedupe berbeda (Setting vs `ReminderLog`). | Notifikasi bisa terasa dobel; dua cara konfigurasi. | Satukan ke satu mesin pengingat (`ReminderLog`) dan satu halaman pengaturan teks. | P3 |

## E. Yang sudah terintegrasi baik (tidak perlu tindakan)

- Laporan shift → stok (patung basah/kering, barang jadi), reject, neraca, LPG, standar, alert (P1–P5, #139).
- Borongan ↔ stok titik ↔ laporan Assembling (KRM/AMB, setoran, reject bahan).
- Pembelian/penerimaan barang ↔ hutang ↔ jurnal ↔ laporan shift (`ShiftReceipt` dipasangkan ke pesanan).
- Keuangan (Transaksi, Mutasi, Cek saldo) dan bot memakai fungsi inti yang sama.
- Resep HPP membaca tarif borongan otomatis (#136); Alur Produksi membaca laporan shift (PR #146).

## F. Rencana urutan (usulan)

1. **Sebelum 1 Des (P1):** ganti sumber dashboard + rekap 07.00 + bot (A), blokir mutasi manual barang otomatis, tautkan `/stok/selisih`, kunci/arsipkan alur klaim lama `PieceWork`.
2. **Desember (P1/P2):** invoice/penjualan marketplace dari impor pesanan, "Pemantauan stok" gabungan, satu "Hitung fisik".
3. **Kapan saja (P3):** rapikan menu, rute yatim, pengingat tunggal.

## G. Status pengerjaan P1 (PR "P1 integrasi")

| Butir | Status |
|---|---|
| Dashboard, rekap Telegram 07.00, `/rekap` & `/ringkasan` bot, Laba produk membaca Laporan Shift + Borongan (`alurProduksi.ts`) | Selesai; kartu "Input hasil" di dashboard diganti "Buka laporan shift"; tes sinkron dashboard = rekap = Alur Produksi = ringkasan laporan |
| Bot: menu input produksi | Hanya Owner (koreksi); semua orang diarahkan ke Laporan Shift bila sakelar `laporan_shift_ke_stok` menyala |
| Stok › Mutasi (web + bot) | Barang otomatis (patung cetak/kering, barang jadi) setelah cut-over: non-Owner ditolak; Owner wajib alasan, tercatat berlabel "KOREKSI (Owner)". Mutasi bot kini memakai aturan yang sama (sebelumnya melewati aturan) |
| `/stok/selisih` | Ditautkan dari Stok dan kartu Cut-over |
| Gaji › Borongan (`PieceWork`) | Read-only + banner. **Catatan koreksi audit**: alur ini untuk karyawan bersistem upah Borongan/Campuran (karyawan tetap), BUKAN pekerja borongan tetangga (yang memakai Borongan › Klaim Upah). Banner menampilkan jumlah hasil/klaim yang masih terbuka; tidak ada migrasi otomatis |
