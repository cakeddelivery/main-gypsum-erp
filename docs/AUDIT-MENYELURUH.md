# Audit menyeluruh — logika & angka (13 Nov 2026)

Lingkup: akuntansi & keuangan, stok & HPP, gaji & absensi, penjualan & marketplace, keamanan & izin, bot Telegram.
Tampilan/mobile tidak termasuk (dikerjakan utas S). Kode yang diperiksa: `main` sampai PR #81, ditambah PR #82 (belum merge).

Tanda: ✅ = sudah diperbaiki di branch `claude/audit-menyeluruh` (beserta tes `tests/auditMenyeluruh.test.ts`),
❓ = perlu keputusan Owner, 📝 = dicatat, belum diubah.

---

## A. Temuan berurut prioritas

### KRITIS (angka bisa salah besar)

| # | Temuan | Bukti | Dampak (bahasa sederhana) | Status |
|---|---|---|---|---|
| K1 | **Kirim laporan shift dua kali bersamaan** (klik ganda / sinyal lambat) memotong stok bahan dua kali. Status "sudah diterapkan" dibaca di luar transaksi, tanpa kunci. Hal yang sama untuk hasil kerja → stok dan stok akhir hasil. | `src/lib/shiftReportStock.ts:26` (dulu baca `stockApplied` di luar transaksi), `src/lib/shiftReportFlow.ts:92`, `src/lib/shiftResultCount.ts:267` | Stok bahan baku berkurang 2×, "Pemakaian Bahan Baku" (HPP) jadi 2× lebih besar, laba terlihat lebih kecil. Patung kering / produk jadi bisa dobel. | ✅ Laporan dikunci (`FOR UPDATE`) dan dibaca ulang di dalam transaksi. Tes membuktikan kode lama gagal, kode baru lolos. |
| K2 | **Revisi laporan shift (hasil kerja)**: mutasi pembalik versi lama bertanggal *hari ini*, padahal posting baru bertanggal *jam selesai shift*. | `src/lib/stock.ts:386` (`date: new Date()`), `src/lib/shiftReportFlow.ts:51-58` | Pada jam shift itu stok patung kering/produk jadi terhitung dobel sampai hari revisi, sehingga stok akhir hasil (hitung fisik) menilai selisih yang salah dan bisa membukukan "selisih persediaan" palsu. Jurnal pembalik juga pindah tanggal. | ✅ Pembalik revisi memakai tanggal mutasi/jurnal aslinya (bila periode masih terbuka). |
| K3 | **Nilai barang jadi dari resep ikut memasukkan upah & overhead** barang setengah jadi (mis. Patung Kering yang resepnya berisi upah cetak, Listrik, Gaji Produksi). Komentar fungsinya sendiri berkata "hanya bahan", tetapi perhitungan memakai HPP lengkap komponen. | `src/lib/hpp.ts` `recipeMaterialCost` (dulu memakai `productCosting().material`, yang untuk komponen setengah jadi = HPP penuh) | Persediaan barang jadi dinilai terlalu tinggi; akun "Pemakaian Bahan Baku" dikredit terlalu besar (HPP bahan tampak terlalu kecil/minus), sementara upah tetap dibebankan lewat gaji → **upah & overhead terhitung dua kali** saat barang dijual. Berlaku untuk laporan shift Assembling/Packing/Giftbox, Penjualan offline (HPP cadangan), dan input produksi tahap Barang Jadi. | ✅ Nilai untuk pembukuan sekarang benar-benar hanya bahan + kemasan (rekursif). HPP untuk saran harga tidak berubah. |
| K4 | **Nominal "1.5jt" dibaca Rp15.000.000** (titik dianggap pemisah ribuan walau ada satuan). | `src/lib/money.ts:17` `parseIDR` | Pesan bot / teks transaksi yang menulis "1.5jt", "2.5rb" tercatat 10× lipat. "1,5jt" (koma) sudah benar. | ✅ Titik + 1–2 angka sebelum jt/rb/k = desimal; "1.250rb" tetap 1.250.000. |

### SEDANG

| # | Temuan | Bukti | Dampak | Status |
|---|---|---|---|---|
| S1 | **Withdraw marketplace dicatat sebagai penjualan sebesar uang yang ditarik (neto)**, bukan omzet kotor. Biaya admin/komisi Shopee & TikTok tidak pernah tercatat sebagai beban. | `src/lib/finance.ts:335`, `withdrawIncomeLines` | Laba bersih tetap benar, tetapi "Penjualan" di laba rugi lebih kecil dari omzet sebenarnya dan biaya marketplace (±14–18%) tidak terlihat, sehingga margin per kanal tidak bisa dianalisis. Juga pendapatan diakui saat WD, bukan saat pesanan selesai. | ❓ lihat pertanyaan 1 |
| S2 | **Aset tetap dibeli dengan "Hutang usaha" tidak membuat dokumen Hutang.** Jurnalnya Cr 2-1100, tetapi tidak muncul di daftar Piutang & hutang, tidak bisa dicicil lewat menu, dan saldo akun Hutang Usaha ≠ total daftar hutang (S4 lama). | `src/app/(app)/akuntansi/actions.ts:223` | Hutang ke penjual mesin/peralatan "tidak terlihat"; pengingat jatuh tempo tidak jalan; rekonsiliasi hutang selalu selisih. | ❓ pertanyaan 2 |
| S3 | **Peralatan yang dibeli lewat Transaksi tidak menjadi Aset Tetap** (S5 lama), jadi tidak disusutkan; seluruh harga langsung jadi beban hari itu. | alur `bookInTx` di `src/lib/finance.ts` | Laba bulan pembelian terlalu kecil, bulan berikutnya terlalu besar. | 📝 saran fitur no. 4 |
| S4 | **HPP penjualan marketplace baru diakui saat opname barang jadi akhir bulan.** Penjualan marketplace tidak mengeluarkan stok per pesanan. | `src/lib/stock.ts:279` `finishedGoodsOpname` | Laba rugi harian/mingguan tanpa HPP (terlihat terlalu untung) sampai opname; bila opname terlewat, HPP bulan itu kosong. | 📝 saran fitur no. 3 |
| S5 | **Pekerja borongan bisa diberi kasbon** lewat web & bot, padahal aturan bisnis melarang. | `src/lib/payroll.ts` `giveAdvance` | Kasbon tidak pernah terpotong (klaim borongan jarang/terpisah) → piutang karyawan menggantung. | ✅ ditolak dengan pesan jelas |
| S6 | **Atur saldo rekening dibukukan pukul 12.00**, padahal saldo buku dihitung sampai akhir hari (R2 lama). | `src/app/(app)/akuntansi/actions.ts:276` | Di Mutasi rekening, transaksi sore hari itu tampil "sesudah" penyesuaian sehingga saldo berjalan per jam keliru; cek saldo pagi tetap benar. | ✅ sekarang 23.59 WIB |
| S7 | **Opsi "Akun COA hutang" untuk pinjaman berisi semua kewajiban** termasuk Hutang Gaji & Hutang Kompensasi Pengelola (R3 lama). | `src/app/(app)/akuntansi/piutang-utang/page.tsx:22` | Salah pilih → pinjaman tercampur dengan hutang gaji / kompensasi, saldo kedua akun kacau. | ✅ akun sistem (2-1100, 2-1200, 2-1210) tidak ditawarkan |
| S8 | **Hapus entri produksi / setoran borongan: jurnal & mutasi pembalik bertanggal hari ini**, bukan tanggal asli. | `src/lib/stock.ts:413`, `src/lib/borongan.ts:278` | Bila dihapus beberapa hari kemudian, laporan harian kedua tanggal berubah (bersih di total bulanan). | 📝 dibiarkan: mengubah tanggal mundur bisa menggeser opname yang sudah terjadi sesudahnya; aman bila dihapus di hari yang sama |
| S9 | **Overhead "Gaji Produksi" otomatis (PR #82)** dijumlahkan dari gaji semua divisi laporan shift. Bila resep juga punya baris *Tenaga kerja* untuk karyawan yang sama, HPP saran harga menghitung gaji dua kali. | `src/lib/salaryOverhead.ts` (PR #82) | Saran harga terlalu tinggi (tidak memengaruhi jurnal). | 📝 saat merge #82: pastikan resep memakai salah satu saja (upah per pcs **atau** overhead gaji) |

### KECIL

| # | Temuan | Bukti | Status |
|---|---|---|---|
| R1 | Telat untuk shift yang lewat tengah malam salah (mulai 22.00, absen 00.10 = tidak telat; mulai 00.30, absen 23.50 = telat 23 jam). | `src/lib/attendance.ts:5` | ✅ |
| R2 | Pembayaran cicilan dari tabungan 0006: tanggal catatan "Tarik" memakai tanggal UTC (transaksi 00.00–06.59 WIB tercatat sehari sebelumnya). | `src/lib/finance.ts` `syncLoanSaving` | ✅ |
| R3 | Jatah libur blok sisa di akhir siklus: blok 1–3 hari dapat jatah 0, blok 4–6 hari dapat 1 (`Math.round`). Wajar, tapi perlu diketahui saat menjelaskan bolos ke karyawan. | `src/lib/payroll.ts:96` | 📝 (aturan bisnis, tidak diubah) |
| R4 | Daftar hutang untuk bot & form hanya 200/300 dokumen terbaru; hutang lama yang belum lunas di luar itu tidak muncul. | `src/lib/payables.ts:147,159` | 📝 belum berdampak (dokumen masih sedikit) |
| R5 | Rincian bahan baku di Transaksi: harga per satuan dibulatkan (`amount ÷ qty`), sehingga nilai stok bisa selisih beberapa rupiah dari jurnal. | `src/lib/finance.ts:458` | 📝 selisih < Rp1 × qty |
| R6 | Pembelian: `buyPrice` item diisi `harga satuan × qty`, bukan total baris yang diketik (selisih pembulatan). | `src/lib/purchase.ts:125` | 📝 |
| R7 | Laporan shift memanggil `itemCosts()` sekali per barang hasil (lambat bila katalog besar). | `src/lib/shiftReportFlow.ts` | ✅ dihitung sekali |

### Yang diperiksa dan **sudah benar**

- Jurnal selalu seimbang & bilangan bulat (`validateLines`), jurnal append-only, pembalik tidak bisa dibalik dua kali, periode tertutup ditolak.
- Saldo rekening = saldo akun COA (1 rekening = 1 akun); arus kas selalu klop (ada kelompok Penyesuaian).
- Tutup buku idempoten, penyusutan tidak melebihi umur, bulan lama ikut ditutup; job terjadwal ditandai "sudah jalan" sebelum dijalankan (aman diulang, tidak dobel).
- Nomor otomatis & kode memakai `INSERT … ON CONFLICT` (aman bersamaan); mutasi stok mengunci baris barang; pembayaran hutang, gaji, kasbon, penjualan, sisihan mengunci baris dokumennya.
- Barang masuk laporan shift ↔ Pembelian tidak dobel (stok masuk bertanggal waktu barang masuk); pesanan dalam pengiriman → uang muka, terima sebagian proporsional, sisa → piutang refund.
- Konversi satuan beli ↔ satuan resep (`hppFactor`), harga manual Owner ditimpa pembelian berikutnya, resep berjenjang dengan deteksi lingkaran.
- Gaji: siklus dari tanggal masuk, go-live, absen belum divalidasi menahan persetujuan, resign sebelum gajian = Rp0 (juga dicek ulang saat bayar), kasbon tidak terpotong dua kali, akrual Hutang Gaji, tunjangan tgl 15, BPJS wajib pilih karyawan.
- Borongan: pembagian tarif harus = budget, hasil tidak boleh melebihi bahan di titik, jatah driver ke Beban Transport (bukan Kompensasi Pengelola).
- Izin: semua server action memakai pembungkus `action(izin)` atau `assertPerm`; semua route file & halaman memakai `requirePerm`; kapten/operator hanya divisinya; override menu tidak bisa membuka izin terbatas (`RESTRICTED`, `telegram.manage`). Cron & webhook memakai rahasia dengan perbandingan waktu-konstan.
- Waktu: semua hitungan hari memakai WIB (`jakartaParts`, `dayRange`, `monthRange`).
- Bot: alur permintaan stok manual sudah diarahkan ke "otomatis dari laporan shift"; tidak ada sisa "karakter gypsum".

---

## B. Saran optimasi fitur yang sudah ada (urut manfaat ÷ usaha)

1. **Cek kecocokan otomatis di Tutup buku** (usaha kecil, manfaat besar): satu tabel ✓/selisih untuk Persediaan (nilai stok vs akun 1-1401/1402/1403), Piutang & Hutang (daftar dokumen vs akun 1-1300/2-1100/2-1400), Dana dalam Perjalanan (WD Dalam Proses vs akun), Hutang Gaji (periode Disetujui vs akun 2-1200), Uang Muka Pembelian (pesanan menunggu vs akun 1-1510). Semua datanya sudah ada; `scripts/audit-akuntansi.ts` sudah menghitungnya untuk VPS.
2. **Peringatan "HPP Rp0"**: daftar produk jadi yang harga pokok & resepnya kosong (penjualan tercatat tanpa HPP). Tampil di Beranda Owner.
3. **Penjualan marketplace keluar stok per hari** (dari rekap resi yang sudah ada di #81): stok & HPP terbukukan harian, opname akhir bulan tinggal mengoreksi selisih kecil.
4. **Kategori Transaksi "Peralatan/Aset"** → otomatis membuat Aset Tetap (umur manfaat ditanyakan), sehingga ikut disusutkan.
5. **Revisi laporan shift menampilkan selisih** sebelum dikirim ulang ("stok bahan akan berubah −2 sak").
6. **Hapus produksi/setoran lama**: tanyakan tanggal pembalik (tanggal asli/hari ini) bila lewat 1 hari.

## C. Rekomendasi fitur baru dari data yang sudah ada (urut manfaat ÷ usaha)

1. **Proyeksi kas 30 hari** (kecil): saldo hari ini + piutang jatuh tempo − hutang/cicilan jatuh tempo − gaji H+7 − tunjangan tgl 15 − sisihan harian. Menjawab "cukup tidak uang Seabank 5984 bulan ini?".
2. **HPP aktual vs resep per bulan** (sedang): pemakaian bahan dari laporan shift ÷ patung kering yang dipanen, dibanding resep → tanda bila boros (mis. gypsum per patung naik 15%).
3. **Laba per kanal (Offline/Shopee/TikTok)** (sedang): penjualan offline sudah per nota; marketplace dari WD + biaya admin (butuh keputusan pertanyaan 1).
4. **Produktivitas & reject per karyawan/divisi** (kecil): dari laporan shift + absensi (hasil per jam kerja, alasan reject terbanyak).
5. **Skor ketepatan laporan** (kecil): laporan terlambat/tidak dikirim per divisi per bulan.
6. **Pengingat stok habis berdasarkan laju pemakaian** (sedang): "gypsum habis ±4 hari lagi" dari rata-rata pemakaian 14 hari, bukan hanya limit tetap.

---

## D. Pertanyaan untuk Owner

1. **Penjualan marketplace (S1)**: catat tetap neto saat WD (sekarang), atau catat omzet kotor + biaya admin sebagai beban dari file "Laporan Penghasilan" Shopee/TikTok tiap bulan? Rekomendasi: tetap neto harian + **jurnal bulanan dari file penghasilan** (omzet kotor & biaya admin dipisah, laba tidak berubah).
2. **Aset dibeli dengan hutang (S2)**: buat dokumen Hutang otomatis (wajib isi nama pemasok & jatuh tempo)? Rekomendasi: ya.
