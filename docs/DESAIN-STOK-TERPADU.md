# Desain teknis: stok terpadu lewat Laporan Shift (draf untuk Owner)

Status: DESAIN (rev. 2 setelah jawaban Owner 19 Nov), belum ada kode. Dasar: `docs/AUDIT-ALUR-STOK.md`, `src/lib/shiftReport*.ts`, `shiftReportFlow.ts`, `shiftResultCount.ts`, `stock.ts`, `boronganFlow.ts`, `hpp.ts`.
Semua perubahan data bersifat **aditif** (tabel/kolom baru), tidak mengubah data lama.

## 0. Prinsip
1. **Laporan shift = satu-satunya tempat karyawan mencatat produksi & stok.** Menu Produksi manual hanya untuk koreksi Owner (tahap manual sudah ditutup oleh `FLOW_STAGES` bila sakelar menyala).
2. Setiap barang punya **status + lokasi** yang tercatat **sekali**: bahan baku → patung basah → patung kering → Single Pack / produk jadi → terjual / reject. Lokasi: gudang bahan, setengah jadi, barang jadi, driver, titik borongan, **Reject** (baru).
3. Tidak ada angka yang "hilang diam-diam": setiap pengurangan stok punya jenis (dipakai, dikirim, terjual, reject, selisih hitung).
4. Selisih hitung fisik vs sistem = **kebocoran**, dicatat per barang/divisi/shift/PIC.

## 1. Alur data per divisi (apa yang dicatat di laporan shift)
Semua angka masuk lewat `postShiftWork` (ref `LPH:<laporan>:<versi>`), bertanggal jam selesai shift. Hasil borongan tetap bersumber dari mutasi borongan (KRM/BGI/HSB/PND), **tidak diposting dua kali** (lihat §6).

| Divisi | Dipakai (keluar) | Dihasilkan (masuk) | Reject (per jenis + jumlah + alasan) | Hitung fisik akhir |
|---|---|---|---|---|
| **Cetak** | bubuk gypsum (sak) — hanya gypsum + air; **air tidak dilacak** (biaya PDAM tetap/overhead) | patung cetak/basah per varian (Hewan, Cowok, Cewek, Transportasi) | patung basah retak/pecah/cetakan rusak per varian | gypsum (sak), patung basah per varian |
| **Oven** | patung basah masuk oven per varian, **LPG per tabung 5 kg** (tabung habis/diganti shift ini) | patung kering per varian | patung gosong/retak/pecah per varian | patung kering per varian, tabung LPG penuh & terpasang |
| **Assembling** | patung kering, bahan (background, klip, cat, plastik…) | Single Pack / produk setengah jadi per varian; **baris otomatis "Keluar ke borongan / Masuk dari borongan"** dari KRM/AMB | rusak saat assembling per varian | Single Pack per varian, bahan |
| **Giftbox** | patung kering (5/box), dus, bahan kemas | Giftbox per SKU | rusak per SKU | giftbox, bahan kemas |
| **Packing** | Single Pack/produk jadi per varian, dus, bubblewrap, label, dll. | paket terkemas / resi terkirim | rusak/salah kirim per jenis | produk jadi, dus |

Borongan di laporan (otomatis, hanya tampil): KRM = keluar dari gudang ke driver/titik; HSB = pemakaian bahan di titik; AMB/PND = setoran masuk gudang; reject setoran = penyesuaian bertanda. Sehingga stok akhir laporan = stok aplikasi tanpa input manual ganda (menyelesaikan tugas "sinkron stok setengah jadi ↔ laporan shift": Oven 3000 → KRM 2000 → sisa 1000).

Resi: **"dibuat dari nol" = produk disiapkan (prepare) saat pesanan masuk**, bukan diambil dari stok jadi (jawaban Owner). Tiap resi di laporan Packing/Giftbox mencatat `sumber = STOK | DISIAPKAN`; DISIAPKAN menurunkan Single Pack/patung kering/bahan kemas sesuai resep BOM lalu langsung keluar (HPP); STOK mengurangi produk jadi. Keduanya tercatat per resi (menyelesaikan celah "resi tanpa jejak stok").

## 2. Form laporan shift yang berubah (field baru)
- **Semua divisi**: blok "Reject" — baris dinamis (jenis barang · jumlah · alasan dari daftar: retak, pecah, gosong, cacat cat, salah cetak, lainnya + catatan). Wajib bila selisih stok akhir > 0 yang tidak terjelaskan (peringatan, bukan penghalang kirim).
- **Cetak**: gypsum terpakai dihitung dari stok awal + barang masuk − stok akhir fisik (sak), bukan diketik; patung cetak per varian (sudah ada) + reject per varian. Air tidak diisi.
- **Oven**: "patung basah masuk oven" (dipilih dari stok basah), kering per varian (ada), **LPG per tabung**: isian "tabung kosong diganti (isi ulang) shift ini" + stok tabung penuh & terpasang (hitung fisik). Pemakaian = tabung habis × 5 kg.
- **Assembling/Packing/Giftbox**: konsumsi kering/Single Pack/bahan kemas tampil sebagai **hasil perhitungan resep** (bisa diedit dengan alasan bila berbeda).
- **Semua divisi — wajib hitung sisa SEMUA bahan pendukungnya** (lihat §4B): bahan yang tidak dihitung tidak bisa dialert, jadi ditandai "belum dihitung" di halaman Kebocoran.
- **Neraca** (read-only di laporan): per barang: awal + masuk − keluar − reject = sistem; hitung fisik; selisih. Selisih besar diberi tanda.
- PIC otomatis dari akun (sudah) dan **shift dari absen** (#126).

## 3. Model data (aditif)
- `ShiftMovementLine` (reportId, itemId, kind ∈ {PRODUKSI, PAKAI, MASUK, KELUAR, REJECT, BORONGAN_KELUAR, BORONGAN_MASUK, TERIMA, JUAL}, qty, ref, note): jejak per laporan, diturunkan dari mutasi `StockMovement` (bukan sumber baru) agar neraca bisa dijelaskan.
- `ProductionReject` (id, reportId, divisionId, stage ∈ {CETAK, OVEN, ASSEMBLING, GIFTBOX, PACKING}, itemId, qty, reasonCode, note, createdBy) + **lokasi stok Reject per tahap** (keputusan Owner: 1 gudang Reject per tahap — Cetak, Oven, Assembling, Giftbox, Packing; setting `loc_reject_<tahap>`). Reject = `TRANSFER` stok dari gudang tahap ke Reject (stok tetap tercatat, bukan hilang) + opsional jurnal beban "Barang Reject" bila nilai dihapusbukukan.
- `ShiftBalance` (reportId, itemId, opening, inQty, outQty, rejectQty, systemClosing, countedClosing, diff, diffValue, picName, computedAt): snapshot neraca saat laporan dikirim/direvisi; sumber halaman Kebocoran & alert.
- `UsageStandard` (id, outputItemId, inputItemId, basis ∈ {PER_OUTPUT, PER_PAKET, RENDEMEN, BIAYA_PER_UNIT}, mode ∈ {AUTO, MANUAL}, value, sampleDays, sampleCount, toleranceAuto?, updatedAt, pinnedBy): standar pemakaian.
- `StockAnomaly` (id, type, severity, divisionId?, itemId?, reportId?, shiftId?, date, expected, actual, pct, status ∈ {BARU, DILIHAT, DIJELASKAN}, note, noteBy, pushedAt): dedupe alert + riwayat penjelasan.
- Barang **"LPG tabung 5 kg"** (satuan tabung, bahan baku divisi Oven): pembelian = isi ulang per tabung di toko (harga isi ulang masuk harga rata-rata); stok = tabung penuh (+ 1 terpasang); `UsageStandard` memakai tabung habis × 5 kg.
- Setting: `stok_terpadu_mulai` (tanggal cut-over), `laporan_shift_ke_stok` (sudah), `anomali_ambang_persen` (bawaan 15), `loc_reject_<tahap>`.
- Migrasi: hanya CREATE TABLE/ADD COLUMN; tidak ada backfill wajib (neraca historis dihitung ulang on-demand dari `StockMovement`).

## 4. Rumus
**Neraca per barang per shift** (barang di gudang tahap L, jendela W = jam selesai shift sebelumnya → jam selesai shift ini):
- `awal` = hitung fisik akhir shift sebelumnya (bila ada & diterapkan), jika tidak stok sistem pada awal W.
- `masuk` = Σ mutasi ke L dalam W (HASIL_PRODUKSI, PENERIMAAN, TRANSFER masuk/PND/AMB, retur baik).
- `keluar` = Σ mutasi keluar dari L dalam W kecuali reject (KONSUMSI_PRODUKSI, PENGELUARAN jual, TRANSFER KRM/BGI).
- `reject` = Σ transfer ke `loc_reject_<tahap>`.
- `sistemAkhir = awal + masuk − keluar − reject`; `selisih = fisikAkhir − sistemAkhir` (negatif = kebocoran/hilang, positif = salah catat/belum dicatat); `nilaiSelisih = selisih × HPP`.
- Hitung fisik diterapkan sebagai PENYESUAIAN (`LPS:` — sudah ada) sehingga stok aplikasi = stok akhir laporan.

**Standar pemakaian** — dua sumber, dipakai bersama:
- **A. Standar proses (historis, AUTO bergulir 30 hari)** dari neraca shift yang selisihnya kecil (agar kebocoran tidak meracuni standar):
  - gram gypsum / patung basah (Cetak; air tidak dilacak) = Σ(sak terpakai × gram per sak) / Σ(patung cetak bagus + reject), per varian bila datanya cukup (1 sak gypsum = 18 kg = 18.000 g, keputusan Owner; disimpan di `hppFactor` barang gypsum);
  - rendemen = Σ kering / Σ basah masuk oven;
  - LPG per patung kering: tabung habis × 5 kg / Σ kering; **Rp per patung kering = (tabung habis × harga isi ulang rata-rata) ÷ patung kering**;
  - biaya per unit: Rp gypsum per patung basah, Rp LPG per patung kering (menyatu dengan HPP bertingkat `hpp.ts`).
  Nilai = **median** sampel (tahan pencilan), minimal 10 shift; kurang dari itu "belum cukup data". Owner bisa **menetapkan manual** (MANUAL menimpa AUTO; ada "kembali otomatis").
- **B. Standar BOM untuk SEMUA bahan pendukung** (keputusan Owner): standar = **resep BOM (#122) × output** shift itu (`bomStockQty` × jumlah produk/Single Pack/paket yang dihasilkan), dibandingkan **pemakaian aktual dari neraca** = awal + masuk − sisa hitung. Cakupan: plastik OPP, cotton bud, piring, background, klip, cat plastik, klip 2x3, cat 5 warna, pot cat, dus 12/24, dus giftbox, solasi, bubble wrap, plastik wrap, label thermal, stiker, color guide, kuas, sabuk label, magnet, pallet, dst. di setiap divisi dan produk. Berlaku juga di **titik borongan**: pemakaian titik (HSB) vs stok koordinator (neraca stok titik: awal + kiriman − sisa hitung/Koreksi stok).
  - Syarat: tiap bahan pendukung harus punya **hitungan sisa di laporan divisi pemiliknya** (`Item.divisionId`, tersedia di blok stok akhir bahan). Bahan aktif yang **tidak dihitung** pada shift berproduksi ditandai **"belum dihitung"** di halaman Kebocoran (tidak bisa dialert) dan di laporan (peringatan, bukan penghalang kirim).
  - Rasio aktual/standar per bahan per shift = `pemakaian aktual ÷ (BOM × output)`; > 1,15 → alert (§5). Output nol tetapi pemakaian > 0 → alert "pemakaian tanpa hasil".

### 4C. Siklus tabung LPG (sinkron dengan pembelian isi ulang)
Alur: **penuh (gudang) → terpasang (Oven) → kosong → isi ulang (pembelian/transaksi Rp) → penuh**. Barang "LPG tabung 5 kg" dengan lokasi/status: penuh, terpasang, kosong.
- Laporan Oven: "tabung kosong diganti shift ini" (+ stok penuh & terpasang hitung fisik) → tabung penuh −n, tabung kosong +n.
- Isi ulang = pembelian/transaksi (web atau bot Transaksi) yang **ditautkan ke barang LPG**: tabung kosong −n, penuh +n; harga per tabung diambil dari transaksi itu (harga rata-rata).
- Neraca tabung per hari/minggu: tabung habis dilaporkan vs isi ulang dibeli; alert bila isi ulang dibeli > tabung habis, tabung habis tanpa pembelian, atau tabung kosong menumpuk.

## 5. Alert anomali (push + lonceng + rekap harian) dan ambang
Penerima: Owner, Supervisor, Finance. Dedupe per (jenis, divisi, barang, tanggal). Ambang bawaan bisa diubah Owner.
| Alert | Syarat (bawaan) | Tingkat |
|---|---|---|
| Pemakaian > standar (proses: gypsum/patung, rendemen, LPG) | aktual > standar +15% pada satu shift, atau rata-rata 3 shift berturut-turut > 10% | Sedang/Tinggi |
| **Pemakaian bahan pendukung > BOM × output** (semua bahan pendukung, semua divisi & titik borongan) | aktual > BOM × output +15% (disetujui Owner); nilai Rp selisih ditampilkan | Sedang (Tinggi bila nilai besar) |
| Bahan pendukung belum dihitung | bahan aktif divisi tidak punya hitungan sisa pada shift berproduksi | Rendah (tampil di halaman Kebocoran) |
| Selisih neraca | \|selisih\| ≥ 10 unit dan ≥ 10% stok sistem (sama `bigDiff`), atau nilai ≥ Rp ambang | Tinggi |
| Reject di atas normal | reject% shift > rata-rata 30 hari + 50% (min 5 unit) | Sedang |
| Reject tanpa alasan | ada reject dengan alasan kosong | Rendah |
| Stok minus | stok sistem < 0 untuk barang apa pun | Tinggi |
| Barang masuk tanpa pembelian | BMK belum ditautkan > 3 hari (sudah ada di Cek Konsistensi) | Sedang |
| Pembelian tanpa barang masuk | pesanan Dikirim > 7 hari belum diterima | Sedang |
| Hasil tidak terposting | laporan terkirim tetapi sakelar mati / `workPostedVersion = 0` | Tinggi |
| Tabung LPG tidak sinkron | tabung habis (laporan) ≠ isi ulang (pembelian) per hari/minggu melewati toleransi 1 tabung | Sedang |
| LPG anomali | tabung habis per patung kering > standar +15%, atau tabung habis tanpa hasil | Tinggi |
| Laporan ganda/hilang | shift berorang tanpa laporan (aturan #128) | Rendah |

**Halaman "Kebocoran & Efisiensi"** (asisten Owner, bahasa awam): ringkasan minggu ini ("Gypsum terpakai 8% lebih banyak dari biasanya = sekitar Rp X"), tren 30 hari per divisi/varian, daftar kebocoran terbesar (barang · shift · PIC · nilai), reject per tahap + alasan teratas, kartu "standar sekarang" dengan tombol tetapkan manual, dan penjelasan 1 kalimat tiap alert. Hanya baca + tombol "Sudah dijelaskan" dengan catatan.

## 6. Cut-over = tanggal mulai sistem baru (tanpa dobel posting)
Bahasa awam: "cut-over" adalah **hari pertama stok aplikasi dihitung dari laporan shift saja**. Sebelum hari itu semua berjalan seperti sekarang; mulai hari itu laporan shift otomatis mengubah stok. Sebelumnya dilakukan hitung stok awal semua barang supaya mulai dari angka yang benar.

1. Tetapkan `stok_terpadu_mulai = T` (mis. awal bulan). Sebelum T: tidak ada perubahan perilaku.
2. **H-1**: opname awal SEMUA barang (bahan, basah, kering, Single Pack, jadi, LPG) memakai alat Stok awal riil yang sudah ada (`AWAL-`), dibackup dulu (`npm run backup`).
3. **T 00:00**: nyalakan `laporan_shift_ke_stok`; `postShiftWork`/`applyResultCount` hanya memproses laporan **bertanggal ≥ T** (guard baru) sehingga laporan lama tidak ikut terposting.
4. Menu Produksi manual: tahap `PANEN_*`, `ASSEMBLING`, `PACKING`, `BARANG_JADI` ditutup untuk non-Owner (mekanisme `FLOW_STAGES` sudah ada).
5. Hasil borongan tetap dari HSB/PND; laporan hanya menampilkan (tidak memposting) → tanpa dobel. Uji: tes "Oven 3000 → KRM 2000 → laporan Assembling" memastikan stok sama dari dua sisi.
6. Pratinjau paralel 7 hari sebelum T memakai `npm run cek:selisih-stok` (sudah ada) untuk melihat celah sebelum sakelar dinyalakan.
7. Rollback: matikan sakelar; mutasi `LPH:`/`LPS:` dapat dibalik per laporan (`reverseVersion`, sudah ada).

## 7. Rencana PR bertahap
- **P1 – Reject & lokasi Reject**: setting `loc_reject_<tahap>`, tabel `ProductionReject`, blok Reject di form + posting transfer; tes. (Risiko rendah, aditif.)
- **P2 – Neraca per shift**: `ShiftBalance`, mesin neraca (membaca `StockMovement`), tampilan di detail laporan; baris borongan otomatis di laporan (menutup tugas lama sinkron stok).
- **P3 – Oven/Cetak lengkap**: gypsum terhitung dari stok, patung basah masuk oven, LPG tabung/kg; resep konsumsi Assembling/Packing/Giftbox.
- **P4 – Standar pemakaian**: `UsageStandard` AUTO/MANUAL + halaman pengaturan.
- **P5 – Alert & halaman Kebocoran & Efisiensi**: `StockAnomaly`, push + lonceng + rekap harian, dedupe.
- **P6 – Cut-over**: guard tanggal T, kunci Produksi manual, dokumentasi/panduan operasional, pratinjau paralel.
Tiap PR kecil, tes, `npm test` 2×, staging dicoba Owner sebelum merge.

## 8. Risiko & pertanyaan untuk Owner
Risiko: (1) beban ketik karyawan naik — mitigasi: angka diturunkan otomatis, input hanya stok akhir fisik + reject; (2) standar AUTO dari data buruk — mitigasi: median, filter pencilan, mode MANUAL; (3) posting ganda saat cut-over — guard tanggal T + ref unik per versi; (4) laporan lama diedit setelah T — revisi tetap aman lewat versi; (5) alert terlalu banyak — dedupe + ambang bisa diubah + hanya Tinggi yang push.
**Keputusan Owner 19 Nov:** bahan Cetak = gypsum saja (air tidak dilacak); LPG per tabung 5 kg; ambang 15% disetujui; alert bahan pendukung berlaku untuk semua divisi/produk/titik borongan.
**Keputusan Owner (lanjutan):** 1 gudang Reject per tahap; nilai reject langsung jadi beban (tanpa menunggu persetujuan); LPG per tabung. **Bawaan sementara:** penerima alert Owner/Supervisor/Finance.
**Keputusan akhir:** 1 sak = 18.000 g; **tanggal mulai T = 1 Desember 2026** (setting `stok_terpadu_mulai`, bisa diundur); desain disetujui sebagai arah, implementasi P1→P6.
