# Audit alur stok: implementasi vs alur Owner (19 Nov 2026)

Hanya laporan (belum ada perubahan kode). Dibaca dari kode di `main` + PR #126. Data production TIDAK diperiksa; poin bertanda ❓ perlu dicek di data asli.

## Alur Owner (target)
Gypsum (bahan baku) → **Cetak** (patung basah) → **Oven** (patung kering) → **Giftbox / Packing / borongan Assembling KRM–AMB** (stok titik) → barang jadi. Resi bisa dari stok jadi atau dibuat dari nol. Barang masuk dari supplier. Setoran borongan kembali ke gudang. Target: tiap barang punya STATUS + LOKASI tercatat SEKALI, dan stok aplikasi = stok akhir laporan shift.

## Peta implementasi sekarang
| Tahap | Pencatat stok | Lokasi / ref | Catatan |
|---|---|---|---|
| Barang masuk supplier | Pembelian / Terima barang / Barang masuk laporan shift (BMK) | gudang bahan (`loc_raw`), ref PBL/TRM/BMK | stok masuk bertanggal waktu barang masuk |
| Pemakaian bahan baku (gypsum dll.) | Opname bahan di laporan shift (PENYESUAIAN `LAP:`) | gudang bahan | pemakaian = selisih stok sistem vs hitung fisik, bukan dari produksi |
| Cetak → patung basah | `postShiftWork` (`LPH:`) bila setting `laporan_shift_ke_stok` = "true" (BAWAAN MATI) | gudang setengah jadi (`loc_wip`), SJ-CTK-* | |
| Oven → patung kering | idem (panen: basah keluar, kering masuk) | `loc_wip`, SJ-PTG-* | |
| Hitung fisik setengah jadi | `applyResultCount` (stok akhir setengah jadi / produk jadi) | `loc_wip` / `loc_finished` | menyamakan stok sistem ke hitungan laporan |
| Giftbox / Packing | `postShiftWork` (kering keluar, giftbox/jadi keluar = HPP) | `loc_wip` → `loc_finished` | hanya bila setting menyala |
| Borongan KRM (kirim ke titik/driver) | TRANSFER `KRM:` gudang → driver/titik | lokasi driver / titik | |
| Pembagian ke pekerja (BGI) | TRANSFER `BGI:` driver ↔ titik | titik | |
| Hasil pekerja di titik | `HSB:` KONSUMSI bahan + HASIL_PRODUKSI output | titik | otomatis dari setoran × resep |
| Ambil setoran (AMB) → terima divisi | TRANSFER titik → gudang (`PND:`), reject = penyesuaian | gudang | |
| Retur | PENERIMAAN `RTR-…-Pn` (per pcs: Single Pack ke `loc_wip`) | `loc_finished` / `loc_wip` | #126 |
| Resi/penjualan marketplace | TIDAK ada mutasi per resi; HPP lewat opname barang jadi akhir bulan | — | lihat celah 3 |

## Celah & potensi dobel
1. **Dua jalur pencatat hasil produksi** ❓: modul Produksi manual (`PRD:`, tahap PANEN/ASSEMBLING/PACKING/BARANG_JADI) vs laporan shift (`LPH:`). Setting `laporan_shift_ke_stok` mati → stok setengah jadi dari laporan shift TIDAK terposting, tetapi laporan Assembling/Packing tetap meminta "stok akhir setengah jadi"; bila nyala, tahap manual ditutup (kecuali Owner). Risiko: stok aplikasi ≠ stok akhir laporan, atau terhitung dua kali bila dua jalur aktif bersamaan. **Perlu cek: nilai setting di production.**
2. **Setoran borongan vs laporan shift**: hasil Assembling/Cat dari borongan sudah masuk stok lewat HSB/PND; laporan shift Assembling juga memuat hasil. Kode melewatkan hasil borongan di `postShiftWork` ("tidak diposting di sini"), tetapi **hitung fisik setengah jadi** tetap menyamakan ke total → selisih bisa tampil sebagai penyesuaian bila "Keluar ke borongan / Masuk dari borongan" belum tampil di laporan (tugas lama yang tertunda: sinkron stok setengah jadi ↔ laporan shift).
3. **Resi**: tidak ada status per resi/produk (dibuat dari stok vs dari nol). Barang jadi keluar hanya lewat opname bulanan → stok barang jadi tidak real-time dan tidak ada jejak resi ↔ barang.
4. **Status barang tidak eksplisit**: lokasi = gudang bahan / setengah jadi / barang jadi / driver / titik (cukup), tetapi patung basah vs kering, Single Pack, dan "sudah dikemas" hanya dibedakan oleh jenis barang (SJ-CTK, SJ-PTG, Single Pack, BJ), bukan status.
5. **Retur**: baik semua → paket utuh; sebagian → Single Pack di `loc_wip`; nilai persediaan Single Pack memakai HPP komponen (tanpa bahan kemas).
6. **Barang masuk** (BMK): fisik masuk sebelum dicatat di Pembelian → opname menganggap sudah ada (benar), tetapi bila lupa ditautkan, stok sistem menunggu (dipantau Cek konsistensi).
7. **Dobel tanggal**: mutasi borongan memakai jam tetap (05:00 / 06:00 UTC) bukan jam kejadian; laporan shift memakai jam selesai shift → urutan harian bisa tidak sesuai kejadian nyata.

## Usulan perbaikan berurutan (+ risiko data)
1. (Aman, baca saja) Laporan pratinjau "selisih stok aplikasi vs stok akhir laporan" per barang setengah jadi/jadi 14 hari terakhir. Menunjukkan celah 1–2 dengan data asli tanpa mengubah apa pun.
2. Putuskan satu jalur: laporan shift sebagai sumber stok setengah jadi (setting menyala) + tutup tahap manual. Risiko: menyalakan setting tidak memposting laporan lama; perlu tanggal mulai (cut-over) dan opname awal. Wajib `npm run backup`.
3. Selesaikan sinkron borongan ↔ laporan (baris "Keluar ke borongan / Masuk dari borongan", tes Oven 3000 → KRM 2000) agar stok akhir laporan = stok aplikasi.
4. Tambah status/jejak resi: mutasi barang jadi keluar per resi (dari stok / dari nol) menggantikan opname bulanan; risiko: dobel dengan opname → opname jadi pengecekan selisih saja.
5. Cek konsistensi harian: tambah pemeriksaan "stok akhir laporan ≠ stok sistem" dan "hasil kerja belum terposting".

## Yang perlu dikonfirmasi Owner
- Apakah setting "Laporan shift jadi sumber stok" sudah dinyalakan di production?
- Resi dibuat dari nol itu apa persisnya (bahan baku langsung → barang jadi tanpa lewat stok setengah jadi)?
