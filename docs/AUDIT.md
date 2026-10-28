# Audit spesifikasi — Main Gypsum Unified ERP

Sumber: *Main_Gypsum_Unified_ERP_Fitur_Gabungan.pdf* (13 poin). Atas permintaan Owner, **poin 8 dan 10 tidak dibangun**.

## Temuan sebelum pembangunan

1. **Aplikasi sumber tidak tersedia.** Spesifikasi mewajibkan fitur, aturan, dan tampilan "Laporan Shift Divisi" serta "Main Gypsum Finance AI Staging" dipertahankan setelah audit source code. Source dan aplikasi lama tidak diberikan, sehingga sistem ini dibangun ulang dari deskripsi PDF. **Feature parity & visual parity terhadap aplikasi lama belum dapat diverifikasi** (sesuai catatan status verifikasi di PDF).
2. **Sisa poin 8 & 10 di poin lain.** Role *Admin Marketplace* dan *PIC Content Creator* serta rekening *Saldo Penjual Shopee* tetap ada. "Ringkasan penjualan marketplace" di dashboard dihitung dari pemasukan kategori penjualan yang sudah dibukukan (bukan impor file Shopee/TikTok).
3. **Telegram & Hermes** butuh token bot dan endpoint Hermes asli. Seluruh jalur sudah dibuat dan diuji dengan simulasi webhook; tinggal mengisi `TELEGRAM_BOT_TOKEN` dan (opsional) `HERMES_WEBHOOK_URL`.
4. **Supabase.** Database memakai PostgreSQL standar via Prisma, sehingga dapat diarahkan ke Supabase PostgreSQL. Auth & penyimpanan memakai implementasi sendiri (bcrypt/JWT, folder privat) dan perlu diselaraskan bila ingin pindah ke Supabase Auth/Storage.

## Pemetaan fitur

| # | Spesifikasi | Implementasi |
|---|---|---|
| 1 | Dashboard per role (8 role) | `/` — Owner fokus analitik, Admin/Kapten fokus tindakan, Operator ringkas + tombol cepat |
| 1 | Ringkasan produksi, target, barang jadi, reject, produktivitas | Kartu statistik, hasil per tahap, produktivitas per karyawan |
| 1 | Penjualan, pemasukan, pengeluaran, saldo rekening, laba rugi | Per toko & konsolidasi |
| 1 | Grafik tren & notifikasi tertunda | Tren 14 hari; notifikasi transaksi menunggu persetujuan/tinjauan, stok menipis, permintaan stok, laporan belum dikirim, absensi belum divalidasi, penggajian |
| 2 | Alur Cetak → … → Barang Jadi | 11 tahap, visual alur di `/produksi` |
| 2 | Hasil & reject per tanggal/shift/divisi/karyawan | Entri produksi; operator hanya untuk dirinya, kapten untuk divisinya |
| 2 | Shift 1 & 2, jadwal, validasi absensi, target | `/absensi` (jadwal mingguan, validasi), `/produksi/target` |
| 2 | Laporan shift/harian/mingguan/bulanan, preview & unduh JPG | `/laporan/[id]`, `/laporan/rekap` |
| 2 | Kirim laporan, riwayat/status, checklist, keluhan, tindak lanjut | Riwayat pengiriman (Telegram bila aktif) |
| 3 | Bahan baku, WIP, barang jadi per divisi & lokasi | Item per jenis, lokasi terhubung divisi |
| 3 | Penerimaan, pengeluaran, transfer, penyesuaian, permintaan, histori | `/stok/mutasi`, `/stok/permintaan` |
| 3 | Supplier, karakter gypsum, produk, SKU, BOM | `/stok/master`, `/produk/[id]` |
| 3 | Konsumsi bahan dari produksi & nilai persediaan; stok minimum | Tahap Cetak memakai BOM → jurnal BDP; Barang Jadi masuk gudang; harga rata-rata bergerak; peringatan stok minimum |
| 4 | Karyawan, divisi, jabatan, status, akun login | `/karyawan` |
| 4 | Absensi shift dengan toleransi | Status Hadir/Terlambat otomatis dari jam masuk WIB & toleransi shift |
| 4 | Upah harian & borongan (Filling Cat, Assembling), transport assembling | Tarif borongan per tahap, transport per karyawan |
| 4 | Slip gaji, rekap & histori, integrasi biaya tenaga kerja | Periode gaji → setujui → bayar (jurnal beban gaji & transport) |
| 5 | Inbox dari manual, Telegram, AI | `/finance` dengan filter sumber |
| 5 | Masuk/keluar/transfer internal; Seabank, ShopeePay, Saldo Penjual Shopee | Rekening dapat dikelola di Pengaturan |
| 5 | IDR-only, Asia/Jakarta, bukti privat, ekstraksi | Bukti di folder privat + validasi tipe/ukuran/isi; ekstraksi nominal/tanggal/rekening/kategori/catatan |
| 5 | Rekomendasi kategori; status Draft → Dibukukan/Ditolak | Kata kunci kategori; 5 status |
| 5 | Hanya transaksi disetujui yang dibukukan; duplikat; jejak persetujuan | Penguncian baris saat membukukan, deteksi duplikat ±1 hari, approval log |
| 6 | Telegram → Hermes → Finance API | Webhook + forward ke Hermes + `/api/v1` |
| 6 | Draft, opsi interaktif, ringkasan, tombol konfirmasi/batal | Tombol pilih rekening/kategori, ✅ Konfirmasi / ❌ Batalkan |
| 6 | Konfirmasi dipetakan ke identitas Telegram berizin; menu bot khusus Owner | `telegram.manage` hanya Owner (tidak bisa diberikan ke role lain) |
| 6 | Hermes tidak boleh membukukan / akses SQL | API key ber-scope, tanpa endpoint pembukuan |
| 6 | Rekap 07.00 WIB, log pengiriman & kesalahan | Job terjadwal + NotificationLog |
| 7 | COA manufaktur, double-entry, buku besar, saldo rekening | 33 akun awal, validasi seimbang |
| 7 | Piutang, utang, persediaan, aset, saldo awal, penyesuaian | Halaman masing-masing |
| 7 | Transfer internal bukan pendapatan/beban | Diuji otomatis |
| 7 | Laba rugi, neraca, arus kas, jurnal umum, buku besar, kartu persediaan | Semua tersedia + unduh JPG |
| 7 | Tutup buku tgl 1 09.00 WIB; audit log append-only | Job terjadwal; trigger database menolak UPDATE/DELETE audit log & jurnal |
| 7 | Satu organisasi, dua toko, laporan terpisah & konsolidasi | Filter toko di semua laporan |
| 9 | Satuan, paket 12/24/48, giftbox, custom; varian | Tipe & varian produk |
| 9 | BOM, bahan, tenaga kerja, overhead, HPP | HPP = BOM × harga rata-rata + TK + overhead |
| 9 | Histori harga, biaya, margin per produk & kanal | Kanal Offline/Shopee/TikTok Shop/Reseller (input manual) |
| 11 | Login aman, RBAC menu & tindakan | bcrypt, kunci akun, matriks izin per role yang dapat diubah Owner |
| 11 | Pengaturan organisasi, toko, divisi, shift, rekening, kategori, parameter | `/pengaturan` |
| 11 | Bukti privat, validasi input, anti duplikasi, audit trail | `/pengaturan/audit` |
| 11 | Staging & production, backup, monitoring, pemulihan | `APP_ENV`, `/api/health`, skrip backup/restore |
| 12 | Mobile-first, navigasi bawah operator, state loading/empty/error/success | Ya |
| 13 | Modular, API-first, relasional, `/api/v1`, idempotency, atomik, audit, test | 34 test otomatis + CI GitHub Actions |

## Keputusan desain yang perlu diketahui Owner

- **Pembelian bahan** dibukukan dari Finance Inbox (kategori *Pembelian Bahan Baku* → akun Persediaan Bahan Baku). Penerimaan stok hanya mencatat kuantitas & harga rata-rata agar tidak terjadi pembukuan ganda.
- **Biaya tenaga kerja** dibebankan saat gaji dibayar (beban periode), tidak dikapitalisasi ke persediaan. Nilai barang jadi memakai biaya bahan dari BOM.
- **Reject** setelah tahap Cetak dibebankan ke *Beban Reject & Selisih Persediaan* senilai biaya bahan per unit.
- **Koreksi jurnal** selalu lewat jurnal pembalik; jurnal yang sudah dibukukan tidak dapat diubah atau dihapus.
- **Membuka kembali periode** yang sudah ditutup hanya oleh Owner dan wajib mencantumkan alasan (tercatat di audit log).

## Perlu diverifikasi sebelum go-live

- Bandingkan dengan aplikasi lama (alur, istilah, tampilan) bila source atau akses tersedia.
- Isi token bot Telegram & alamat Hermes, lalu uji di staging.
- Sesuaikan COA, kategori, tarif borongan, target, dan data karyawan dengan data nyata.
- Input saldo awal rekening, persediaan, piutang/utang, dan aset.
