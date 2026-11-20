# Cut-over stok terpadu — 1 Desember 2026 (panduan hari-H)

**Arti singkat:** mulai tanggal mulai, stok di aplikasi dihitung dari **Laporan Shift saja**. Menu Produksi manual hanya untuk koreksi Owner.
Halaman pantau: **Stok › Cut-over** (daftar periksa kesiapan + daftar hitung stok awal + ubah/undur tanggal).

## H-7 s/d H-1 (pratinjau paralel)
1. Deploy PR stok terpadu P1–P5 (+ Resep HPP, Sample) ke staging, coba satu shift penuh per divisi.
2. Jalankan `npm run cek:selisih-stok` tiap pagi: lihat selisih stok aplikasi vs stok akhir laporan.
3. Bereskan daftar periksa di **Stok › Cut-over** (bahan tanpa divisi, stok minus, draf laporan tergantung, barang masuk belum ditautkan ke Pembelian).
4. Bila belum siap: **undurkan tanggal mulai** di halaman Cut-over (tidak ada yang berubah sampai tanggal itu).

## H-1 (30 Nov): hitung stok awal
1. `npm run backup`.
2. Unduh **Daftar hitung stok awal** (Stok › Cut-over), hitung fisik semua barang: bahan baku, bahan pendukung, patung basah/kering, Single Pack, produk jadi, tabung LPG (penuh/aktif/kosong).
3. Isi **Stok › Stok awal riil** (tanggal 30 Nov).

## H (1 Des)
1. Nyalakan sakelar **Hasil kerja → stok** di **Laporan › Bahan & checklist divisi**.
2. Mulai saat itu: hanya laporan bertanggal ≥ 1 Des yang diposting ke stok. Laporan bertanggal sebelumnya dilewati otomatis (tidak ada dobel).
3. Produksi manual dikunci untuk non-Owner untuk **semua** tahap.

## Mundur (rollback)
Matikan sakelar; tiap laporan yang sudah diposting bisa dibalik per laporan (revisi laporan membalik versi lama). Reject, sample, dan LPG tetap tercatat sebagai data (tanpa pengaruh stok bila sakelar mati).

## Cut-over dimajukan: dari laporan shift satu tanggal (mis. 20 Nov 2026)
Stok riil = stok akhir laporan shift TERKIRIM tanggal itu (bukan hitung fisik terpisah).
1. `npm run backup`.
2. Borongan: `npm run borongan:tutup-semua` (pratinjau) → `npm run borongan:tutup-semua -- --jalankan`.
   Kiriman yang belum selesai ditandai SELESAI administratif: tanpa mutasi stok (sisa di titik sudah tercermin di laporan shift),
   tanpa upah/klaim/jurnal baru. `--klaim-sisa` (opsional, keputusan Owner) mengajukan klaim upah setoran yang belum diklaim.
3. Pastikan semua divisi sudah MENGIRIM laporan tanggal itu (Assembling ikut laporan divisinya).
4. `npm run stok:cutover-laporan -- --tanggal 2026-11-20` (pratinjau: stok sistem → laporan → selisih qty & nilai, laporan sumber,
   barang "tidak dihitung", laporan wajib belum terkirim) → `... --jalankan` (ditolak bila ada laporan wajib belum terkirim, kecuali `--paksa`).
   Penyesuaian ref `CUTOVER-<tanggal>` pada jam selesai shift laporan sumber; selisih nilai ke Ekuitas Saldo Awal (sama dengan Stok awal riil;
   `--akun-selisih` = Beban Selisih Persediaan). Barang yang tidak dihitung tidak diubah.
5. Tanggal mulai stok terpadu otomatis = HARI BERIKUTNYA (21 Nov): laporan tanggal cut-over sudah tercermin di saldo, jadi kirim ulang
   laporan itu tidak memposting hasil kerjanya lagi. `--mulai-tanggal-sama` bila Owner ingin tanggal yang sama.
