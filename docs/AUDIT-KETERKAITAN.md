# Audit keterkaitan menyeluruh: uang, barang, absensi → gaji (14 Nov 2026)

Permintaan Owner: *"Pastikan keluar masuknya uang, barang, absensi karyawan dan gaji semua pasti sinkron dan berkaitan, jadi tidak ada yang lolos atau tidak berstatus."*

Hasil:
1. Peta alur di bawah: setiap dokumen, status akhirnya, dan jejaknya ke jurnal / stok / rekening.
2. Halaman baru **Akuntansi → Cek konsistensi** (khusus Owner & Finance, hanya membaca) menjalankan **34 pemeriksaan** pada data asli dan menampilkan dokumen bermasalah beserta tautannya. Pemeriksaan yang sama berjalan otomatis **setiap hari 06.00**, dan ringkasannya dikirim ke Owner lewat bot bila ada temuan Kritis/Sedang (`src/lib/consistency.ts`, `src/lib/jobs.ts` `sendConsistencyReport`).
3. Bug yang jelas langsung diperbaiki (dengan tes `tests/cekKonsistensi.test.ts`).

Tanda: ✅ diperbaiki di branch `claude/cek-konsistensi` · 🔎 dipantau Cek konsistensi · ❓ perlu keputusan Owner · 📝 dicatat.

---

## A. Peta alur

### 1. Uang
| Dokumen | Status yang mungkin | Status akhir | Jejak | Dipantau |
|---|---|---|---|---|
| Transaksi (web/bot/AI) | Draft → Perlu Ditinjau → Menunggu Konfirmasi → Dibukukan / Ditolak; Dibukukan → Dibatalkan (jurnal balik); disembunyikan = hanya tampilan | Dibukukan, Ditolak, Dibatalkan | jurnal `FINANCE` (+ `WITHDRAW_PENJUALAN`) | 🔎 draft > 3 hari, Dibukukan tanpa jurnal, Dibatalkan belum dibalik |
| Withdraw TikTok | Dalam Proses → Dibukukan saat "Uang diterima" | Dibukukan | jurnal 1 → Dana dalam Perjalanan, jurnal 2 `WD_DITERIMA` | 🔎 Dalam Proses > 5 hari; saldo Dana dalam Perjalanan = total WD Dalam Proses |
| Baris tertaut (pembelian, gaji, kasbon, borongan, sisihan, penjualan, pinjaman, aset) | ikut dokumen sumber | ikut sumber | jurnal sumber (satu jurnal) | 🔎 baris tertaut masih Dibukukan padahal sumbernya dibatalkan |
| Pembelian | Lunas / Bertahap / Tempo; pesanan: Menunggu → Sebagian → Diterima / Ditutup; Dibatalkan | Diterima/Ditutup/Dibatalkan | `PEMBELIAN` (+ terima barang `TRM`), Hutang, Uang Muka, Piutang refund | 🔎 pesanan > 14 hari, uang muka vs akun 1-1510, batal belum dibalik |
| Penjualan offline | Lunas / Sebagian / Tempo / Lewat jatuh tempo; Dibatalkan | Lunas/Dibatalkan | `PENJUALAN`, Piutang, stok keluar + HPP | 🔎 terbayar > tagihan, batal belum dibalik, piutang vs akun 1-1300 |
| Marketplace | WD = penjualan neto; Biaya marketplace bulanan (#86) | — | `FINANCE`, `MARKETPLACE_BULANAN` | (tampil di halaman Biaya marketplace) |
| Hutang / pinjaman | sisa > 0 → lunas | Lunas | `UTANG`, `PINJAMAN`, `SALDO_AWAL`, `FINANCE` (bayar) | 🔎 daftar hutang vs akun 2-1100/2-1400/akun khusus |
| Kasbon | dicicil lewat slip / pelunasan tunai; Dibatalkan | Lunas/Dibatalkan | `KASBON`, potongan di jurnal `PAYROLL` | 🔎 sisa kasbon vs akun 1-1310 |
| Sisihan (OPS, Nabung Bayar Hutang) | Sisih harian, Tarik | — | `SISIHAN` / jurnal transfer | 🔎 saldo dana minus, tanpa jurnal, hari terlewat |
| Talangan | dipakai → dikembalikan | Kembali | jurnal dompet simpanan + transfer kembali | 🔎 belum dikembalikan |
| Upah borongan | Setoran → Dibayar (pelunasan); Dibatalkan | Dibayar | `BORONGAN` | 🔎 setoran belum dibayar > 30 hari |
| Aset & penyusutan | perolehan → disusutkan tiap tutup buku | habis umur | `ASET`, `PENYUSUTAN` | 🔎 bulan tertutup tanpa penyusutan |
| Semua jurnal | — | — | — | 🔎 tidak seimbang, ganda per dokumen, rekening minus |

### 2. Barang
| Alur | Jejak stok | Jejak nilai | Dipantau |
|---|---|---|---|
| Pembelian / terima barang / barang masuk laporan shift | PENERIMAAN (ref nomor PBL/TRM) | Dr Persediaan | 🔎 barang masuk belum dibeli > 3 hari |
| Opname laporan shift (bahan) | PENYESUAIAN `LAP:` | HPP Pemakaian Bahan Baku | dikunci per laporan (audit 13 Nov) |
| Hasil kerja → stok (sakelar) | `LPH:`, revisi bertanggal asli | Dr Barang Jadi / Cr Pemakaian Bahan | dikunci per laporan |
| Stok awal riil | `AWAL-` (tanpa jurnal per mutasi, satu jurnal Ekuitas Saldo Awal) | Ekuitas Saldo Awal | — |
| Serah terima borongan KIRIM/KEMBALI | TRANSFER `SRT:` gudang ↔ driver ↔ titik | (pindah lokasi, nilai tetap) | 🔎 belum diterima > 3 hari |
| Setoran koordinator → penerimaan divisi (#96) | `HSB:` di titik → `PND:` titik → gudang; reject = penyesuaian | Beban selisih untuk reject | selisih tampil di menu Borongan & laporan shift |
| Penjualan offline | PENGELUARAN ref JUAL | HPP | — |
| Penjualan marketplace | (opname barang jadi akhir bulan) | HPP opname | ❓ lihat C2 |
| Permintaan stok otomatis | — | — | 🔎 terbuka > 7 hari |
| Semua | — | nilai stok vs akun persediaan | 🔎 selisih > Rp1.000, 🔎 stok minus, 🔎 mutasi manual tanpa ref |

### 3. Absensi → gaji
Absen (masuk/pulang, GPS) → validasi → siklus dari tanggal masuk → slip otomatis 06.00 → disetujui (jurnal Hutang Gaji) → dibayar (jurnal pembayaran, potongan kasbon) . Tunjangan tgl 15 & klaim borongan karyawan memakai jalur yang sama.
Dipantau: 🔎 absen hadir belum divalidasi > 3 hari, 🔎 hari kerja tanpa catatan absen melebihi jatah libur (7 hari terakhir), 🔎 siklus selesai tanpa slip / karyawan bulanan tanpa tanggal masuk, 🔎 slip tumpang tindih (dibayar dua kali), 🔎 disetujui tanpa jurnal Hutang Gaji, dibayar tanpa jurnal, gajian lewat belum dibayar, Draft lewat tanggal gajian, 🔎 saldo Hutang Gaji = gaji disetujui belum dibayar.

### 4. Karyawan
Pendaftaran (#83) → disetujui → Karyawan + akun → absensi/gaji. Resign → Nonaktif + akun mati.
Dipantau: 🔎 akun aktif milik karyawan resign/nonaktif, 🔎 pendaftaran menunggu > 3 hari.

---

## B. Temuan

### KRITIS
| # | Temuan | Bukti | Dampak | Status |
|---|---|---|---|---|
| K1 | **Resign terjadwal tidak pernah berlaku.** Bila tanggal resign diisi untuk hari depan, tidak ada yang menonaktifkan karyawan & akun saat tanggalnya tiba. | `src/app/(app)/karyawan/actions.ts:92` (hanya menonaktifkan bila tanggal ≤ hari ini) | Mantan karyawan tetap bisa login web & bot (lihat data, absen, input), tetap terhitung di overhead gaji. | ✅ job 06.00 `applyDueResignations` (`src/lib/payroll.ts:662`); login, sesi web, dan bot langsung menolak sejak tanggal resign (`src/lib/loginGuard.ts:104`, `src/lib/auth.ts:68`, `src/lib/bot.ts:61`) |

### SEDANG
| # | Temuan | Bukti | Dampak | Status |
|---|---|---|---|---|
| S1 | **Tutup pesanan dianggap "jurnal ganda".** Jurnal DP pesanan dan jurnal refund saat pesanan ditutup memakai nomor sumber yang sama. | `src/lib/purchaseReceive.ts:108`, `src/lib/auditChecks.ts:33` | Alarm palsu di audit saldo / cek konsistensi, menutupi jurnal ganda yang asli. | ✅ nomor sumber `PBL…:TUTUP`; data lama dikenali dari keterangannya |
| S2 | **Hari tanpa absensi tidak berstatus.** Hari libur/tidak masuk tidak dicatat apa pun; slip menghitungnya dari "hari tanpa absen hadir". | `src/lib/payroll.ts:83` | Tidak bisa dibedakan libur, izin, lupa absen, atau bolos sampai slip dibuat. | 🔎 dipantau; ❓ C1 |
| S3 | **Absen hadir yang belum divalidasi = tidak masuk** di slip. | `src/lib/payroll.ts:257` | Karyawan bisa terpotong bolos tanpa sadar bila validasi terlambat (persetujuan gaji memang ditahan). | 🔎 dipantau (> 3 hari) |
| S4 | **Sisihan harian bergantung pada bukti/tombol manual**; tidak ada job yang mencatat sisihan otomatis. | `src/lib/reserve.ts:59` (hanya dipanggil dari tombol Sisihkan) | Hari tanpa bukti tidak tercatat → saldo dana sisihan & beban kompensasi kurang. | 🔎 dipantau (hari terlewat 7 hari) |
| S5 | **Gaji lewat bot**: bot belum bisa membayar slip; hanya memberi peringatan bila gaji sudah disetujui (#98). | `src/lib/payrollHint.ts:13` | Bila draft tetap dibukukan, beban gaji dobel. | 🔎 Hutang Gaji vs gaji disetujui; ❓ C3 |

### KECIL
| # | Temuan | Bukti | Status |
|---|---|---|---|
| R1 | Batal penerimaan divisi / hapus produksi / hapus setoran borongan: jurnal pembalik bertanggal hari ini, bukan tanggal asli. | `src/lib/boronganReceipt.ts:138`, `src/lib/stock.ts:413`, `src/lib/borongan.ts:341` | 📝 (total bulanan benar; laporan harian bergeser) |
| R2 | Mutasi stok manual boleh tanpa ref. | `src/app/(app)/stok/actions.ts:32` | 🔎 dihitung (30 hari) |
| R3 | Stok awal riil mencatat mutasi tanpa jurnal per baris (satu jurnal gabungan) — wajar, tetapi selisih nilai stok vs akun bisa muncul bila harga rata-rata berubah sesudahnya. | `src/lib/stockOpening.ts:43` | 🔎 nilai stok vs akun (toleransi Rp1.000) |
| R4 | Penjualan marketplace dicatat neto saat WD; HPP baru diakui saat opname akhir bulan. | `src/lib/finance.ts:335`, `src/lib/stock.ts:279` | ❓ C2 (audit 13 Nov S4) |

### Uji di data tes (seluruh skenario tes)
Cek konsistensi berhasil menemukan: jurnal ganda yang sengaja dibuat tes, transaksi Dibukukan tanpa jurnal, rekening minus, karyawan bulanan tanpa tanggal masuk, **karyawan resign terjadwal yang masih aktif (K1)**, selisih hutang karena data uji yang diubah langsung, stok minus, gaji disetujui tanpa jurnal. Semua sesuai sebabnya.

---

## C. Keputusan Owner (14 Nov 2026: 1a, 2a, 3b)
1. **Hari tanpa absensi → 1a dikerjakan.** Job 06.00 (`src/lib/attendanceAuto.ts`) memberi status Alpa "Tanpa keterangan (otomatis)" untuk hari yang lewat (3 hari ke belakang) bagi karyawan aktif non-borongan yang tidak punya catatan (tidak untuk sebelum tanggal masuk/go-live atau sesudah resign). Di antrean validasi Absensi baris ini tidak tercentang bawaan; ubah menjadi Libur/Izin/Sakit lewat Atur absensi. Slip gaji tidak berubah perhitungannya. Cek konsistensi menghitung hari "tanpa keterangan" yang melebihi jatah libur.
2. **Stok & HPP marketplace harian → 2a: fitur sudah ada.** Laporan shift Packing & Giftbox mengurangi barang jadi + HPP setiap hari bila sakelar **Laporan Shift → Bahan baku → Hasil kerja → stok** (Owner) menyala; opname akhir bulan hanya mengoreksi selisih. Syarat: Stok awal riil diisi dulu. Cek konsistensi mengingatkan bila sakelar masih mati.
3. **Bayar gaji lewat bot → 3b:** tetap lewat web Penggajian; bot hanya memberi peringatan bila gaji sudah disetujui (#98).
