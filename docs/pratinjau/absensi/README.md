# Pratinjau UI/UX Absensi (belum diterapkan)

Gambar pratinjau, belum mengubah kode aplikasi. Ukuran HP 390 px (2×). Memakai gaya, warna, kartu, dan menu bawah ERP sekarang (Beranda · Absen · **+ Lapor** · Laporan · Gaji). Datanya contoh.

| Layar | Varian A (mirip referensi) | Varian B (ringkas) |
|---|---|---|
| 1. Absen masuk (jam berjalan, shift + toleransi, status GPS, tombol besar, selfie opsional) | `1-absen-masuk-A.png` (+ `-gelap`) | `1-absen-masuk-B.png` |
| 2. Sudah absen masuk (foto, waktu hadir + badge Tepat Waktu/Terlambat, lokasi) | `2-sudah-masuk-A.png` (+ `-gelap`) | `2-sudah-masuk-B.png` (contoh Terlambat 12 menit) |
| 3. Absen pulang + peringatan laporan shift belum dikirim (#79, tidak mengunci) | `3-absen-pulang-A.png` | `3-absen-pulang-B.png` |
| 4. Riwayat bulan ini (ringkasan, total telat, kalender, daftar) | `4-riwayat-A.png` (+ `-gelap`) | `4-riwayat-B.png` (tanpa kalender) |
| 5. Izin & Sakit (ajukan + status) | `5-izin-sakit-A.png` | `5-izin-sakit-B.png` (tanpa lampiran/rentang) |

Catatan: fitur pengajuan Izin/Sakit belum ada di aplikasi. Sekarang Izin/Sakit diatur Admin lewat "Atur absensi", jadi layar 5 adalah usulan baru.

## Pertanyaan untuk diputuskan Owner

1. **Foto selfie saat absen?**
   - Manfaat: mencegah titip absen.
   - Biaya: penyimpanan & privasi. Bila ya: foto dikompres kecil (±50 KB) dan dihapus otomatis setelah N bulan, hanya bisa dilihat Supervisor/Owner.
   - Pilihan: wajib / opsional / tidak.
2. **QR absen di lokasi** (dipindai selain GPS) untuk HP yang GPS-nya kurang akurat?
3. **Menu bawah**: tetap seperti sekarang, atau ganti menjadi Beranda · Riwayat · **+ Lapor** · Izin · Lainnya?
4. **Varian**: A (mirip referensi, lebih besar) atau B (ringkas, lebih cepat)? Boleh dicampur per layar.
5. **Izin & Sakit**: siapa yang menyetujui (Supervisor/Owner/Kapten)? Batas waktu pengajuan? Surat dokter wajib untuk Sakit?
