# Audit Laporan Penutup Shift (Tugas N, tahap 1: temuan saja)

Posisi kode: `main` sampai PR #74. Yang dibandingkan: 5 JPG "LAPORAN PENUTUP SHIFT · Standar Kinerja Operasional" yang sekarang dipakai tim (Produksi S1 10 Nov, Produksi S2 9 Nov, Packing S1, Giftbox S1, Assembling S1 10 Nov) dengan kode ERP:
`src/lib/shiftReport.ts`, `src/lib/divisionSetup.ts`, `src/app/(app)/laporan/*`, `src/components/DownloadJpg.tsx`, `src/lib/render.ts`, `src/lib/botMenu.ts`, `src/lib/alerts.ts`, `src/lib/jobs.ts`, `src/lib/stock.ts`.

Belum ada perubahan kode di tahap ini.

---

## 0. Kesimpulan utama: 5 JPG itu kemungkinan besar BUKAN buatan ERP

Format teksnya hampir sama dengan ERP, karena ERP dulu dibuat meniru contoh laporan dari aplikasi lama "Laporan Shift Divisi" (lihat `docs/AUDIT.md` poin 1 dan tes `tests/shiftReport.test.ts`, yang memakai data contoh "YOGA 864", "Eva", "Sonna"). Tapi ada 4 bukti bahwa JPG 9–10 Nov dibuat dari **aplikasi lama**, bukan dari ERP:

| # | Bukti | Di ERP |
|---|---|---|
| 1 | Assembling: semua orang "—" tapi TOTAL 2.800 | Tidak mungkin. TOTAL dihitung dari baris per orang (`colTotals`, `sectionTotal`), dan laporan hanya bisa diisi lewat form web (`saveReport`; bot dan API tidak menulis `ShiftReport`). Kalau semua orang kosong, ERP menulis `TOTAL: Hewan 0 · …` dan `TOTAL PRODUK JADI: 0 pcs`. |
| 2 | Teks terpotong "TO…" (Giftbox, Assembling) | Baris detail memakai `break-words` (`ReportSheet.tsx`), jadi teks panjang turun ke baris berikutnya, tidak terpotong. |
| 3 | Lebar JPG 1010 px dan 757 px | Tombol "Unduh JPG" dan JPG bot menggambar **versi ber-kop surat** (`DocSheet`, `exportWidth=900`, pixelRatio 2), jadi lebarnya selalu **1800 px**. |
| 4 | Kop kuning + logo + footer "Dibuat dari Laporan Shift • N foto bukti" sebagai JPG | Kop kuning itu hanya tampilan **di layar**. JPG ERP memakai kop surat seragam (`DocSheet`): judul "Laporan Penutup Shift", meta "PIC Divisi", tanda tangan "PIC Divisi …", catatan kaki "Dibuat dari Laporan Shift • N foto bukti." |

Artinya: temuan (a) teks terpotong dan (b) lebar tidak konsisten **ada di aplikasi lama, bukan bug ERP**. Masalah sebenarnya adalah tim masih memakai aplikasi lama, sehingga angka 9–10 Nov **tidak masuk ERP sama sekali**: tidak ada stock opname, tidak ada order bahan, dan tidak masuk jurnal Pemakaian Bahan Baku.

Cek di VPS (baca-saja, lihat bagian 6, perintah 1). Kalau hasilnya kosong untuk 9–10 Nov, kesimpulan ini pasti.

---

## 1. Tabel per divisi

Keterangan: **Sama** = format ERP identik dengan JPG. **Kurang di ERP** = ada di JPG/kebutuhan tapi tidak ada di ERP. **ERP lebih lengkap** = ERP punya, JPG tidak. **Bug** = perilaku ERP salah.

### Umum (semua divisi)

| Bagian | Status | Rincian |
|---|---|---|
| Kop kuning, logo, "LAPORAN PENUTUP SHIFT", "Standar Kinerja Operasional", "Divisi • Shift N" | Sama (di layar) | Di JPG ERP diganti kop surat `DocSheet` (sesuai aturan "kop surat identik di semua dokumen"). |
| "YYYY-MM-DD \| PIC Divisi: nama" + ringkasan | Sama | Ringkasan dari `summaryOf`. |
| DETAIL HASIL KERJA | Sama (teks per baris) | ERP membungkus teks panjang; tidak terpotong. |
| CHECKLIST n/m, ✓ hijau + thumbnail, × merah + "foto belum ada" | Sama | Tugas foto dianggap selesai hanya bila fotonya ada (`isDone`). |
| STOK AKHIR SHIFT, ⚠ oranye bila ≤ limit | Sama | `needsOrder` = stok ≤ limit. |
| ORDER BAHAN BAKU (merah) | Sama | Di ERP selalu tampil, dengan teks "Semua bahan di atas limit" bila tidak ada yang perlu diorder. |
| CATATAN / KENDALA | Sama | ERP juga punya **Tindak lanjut + status (Belum/Proses/Selesai)**. Lebih lengkap. |
| Footer "Dibuat dari Laporan Shift • N foto bukti" | Sama | |
| Format angka | Beda kecil | ERP memakai titik ribuan + "pcs" (`TOTAL 1.600 pcs`). Bila JPG lama menulis `1600`, ini hanya beda gaya. |
| Lebar JPG | Bug kecil (aturan) | ERP 900 px (×2), padahal aturan proyek "lebar tetap 1000px". Slip gaji dan nota juga 900. Tetap konsisten, tidak acak seperti aplikasi lama. |
| Stock opname dari stok akhir | ERP lebih lengkap | Saat dikirim, stok akhir menjadi stok sistem. Selisih turun dibukukan ke akun HPP "Pemakaian Bahan Baku" (#72). |
| Halaman Order bahan baku (`/laporan/order`) | ERP lebih lengkap | Rekap order dari hitungan terakhir semua divisi. |
| Kirim ke Telegram | Kurang di ERP | Bot hanya mengirim **teks** ke penerima rekap. JPG harus diminta manual lewat bot ("Unduh laporan"). Tim terbiasa membagikan JPG ke grup. |
| Wajib foto/centang sebelum kirim | Kurang di ERP | Laporan 0/6 tetap bisa dikirim. Tidak ada peringatan khusus ke Owner (hanya baris "✗ … (foto belum ada)" di pesan teks). |
| Validasi isi hasil kerja | Kurang di ERP | Laporan dengan hasil kerja kosong / stok kosong tetap bisa dikirim. |
| Peringatan "laporan kemarin belum dikirim" (Beranda) | **Bug** | `alerts.ts`: target dihitung `jumlah shift aktif × jumlah divisi`. Produksi punya 2 shift, divisi lain 1, jadi dengan 2 shift dan 4 divisi target = 8, padahal laporan yang mungkin hanya 5. Peringatan "3 belum dikirim" muncul terus walaupun semua sudah dikirim. Divisi tanpa format laporan (selain Gudang) juga ikut dihitung. |
| Rekap harian bot "Laporan shift belum dikirim" | Kurang tepat | `jobs.ts` hanya menghitung laporan yang **sudah dibuat** tapi belum dikirim. Laporan yang belum dibuat sama sekali tidak terhitung. |
| Tanggal stock opname | **Bug** | `applyStockCount` memakai **waktu kirim** (`new Date()`), bukan tanggal/shift laporan. Hitungan pertama dibandingkan dengan stok sistem **saat ini**. Kalau laporan dikirim terlambat setelah ada pembelian, pembelian itu "terhapus" menjadi pemakaian. Contoh: hitung 28 sak, besok pagi beli 50 (sistem 78), laporan baru dikirim siang → tercatat pemakaian 50 sak. Kalau laporan Shift 2 tanggal 9 dikirim **sesudah** Shift 1 tanggal 10, stok kembali ke hitungan lama. |
| Stock opname saat kirim Telegram gagal | Bug kecil | Bila pengiriman GAGAL, status laporan tidak berubah, tapi stock opname **tetap diterapkan** (dipanggil sebelum error dilempar). Kirim ulang aman (hanya selisih), tapi membingungkan. |

### Produksi (Shift 1 & 2)

| Bagian | Status | Rincian |
|---|---|---|
| Ringkasan "Total panen \| Total hasil cetak" | Sama | |
| HASIL PANEN Oven Besar/Kecil × Hewan/Cowok/Transportasi/Cewek + TOTAL per oven + TOTAL PANEN | Sama | Contoh S1: 1.600 + 700 = 2.300 ✓. S2: 1.200 + 800 = 2.000 ✓. |
| HASIL CETAK per orang + TOTAL | Sama | Nama orang otomatis diisi dari karyawan divisi, bisa ditambah. |
| Checklist 7 tugas berfoto | Sama | Sama persis dengan `DIVISION_SETUP.PRODUKSI`. |
| Stok 6 bahan + limit | Sama | Bubuk gypsum sak/15, keranjang 700, cetakan 100. |
| Reject + alasan | Kurang di laporan | Ada di modul Produksi (`ProductionEntry.rejectReason`), tapi tidak ada di laporan shift. Kendala "patung mamel" hanya teks bebas. |
| Target panen + capaian | Kurang | Ada `ProductionTarget` (target harian per divisi/orang per tahap, tampil di dashboard dari data Produksi), tapi **tidak dibaca** laporan shift. Tidak ada "Target 2.400 · capaian 83%" atau peringatan tidak tercapai. |
| Masuk ke modul Produksi/stok setengah jadi | **Tidak tercatat** | Angka panen/cetak hanya disimpan sebagai JSON `work`. Tidak membuat `ProductionEntry`, tidak menambah stok setengah jadi, tidak masuk Rekap produksi/Analitik. |

### Packing

| Bagian | Status | Rincian |
|---|---|---|
| Ringkasan "Total resi \| Total patung" | Sama | 138 \| 1.412 ✓. |
| RESI Shopee/Tiktok, PATUNG MIX (paket × isi), PATUNG SATUAN, TOTAL PATUNG | Sama | 12×5+24×17+48×9+96×1 = 996 ✓, satuan 416 ✓, total 1.412 ✓. |
| Checklist 10 (3 foto + 7 centang) | Sama | Persis `DIVISION_SETUP.PACKING`. |
| Stok 8 bahan, order Plastik wrap & Label 78x100 | Sama | Nama bahan di master: "Label termal 100 x 150 (Besar)", "Label thermal 78 x 100 (Kecil)". |
| Keluar barang jadi / HPP penjualan | **Tidak tercatat** | Packing tidak mengurangi stok barang jadi. HPP marketplace masih dari opname barang jadi akhir bulan (Serah-terima §11.4). |

### Giftbox

| Bagian | Status | Rincian |
|---|---|---|
| Ringkasan "Total resi: 0 \| Total patung: 495 pcs" | Sama, tapi kurang tepat | Rumus sama (patung = giftbox × 5; 99 box × 5 = 495 ✓). Tapi ringkasan **tidak menampilkan Total giftbox (99 box)**, padahal itu hasil utama divisi. "Total resi: 0" tampil walau resi tidak diisi. |
| GIFTBOX 10 kode + TOTAL, PATUNG otomatis ×5 | Sama | ERP membungkus teks, tidak terpotong. |
| Checklist 7 (3 foto + 4 centang) | Sama | |
| Stok | Sama (bila master sudah ditambah) | Contoh awal ERP hanya 9 bahan; JPG punya 11 (+ Magnet 15x3mm, Refill lem tembak). Bisa ditambah di Laporan Shift → Bahan & checklist divisi. Cek di VPS (perintah 3). |
| Patung dari Assembling/Filling → Giftbox | Tidak tercatat | Tidak ada perpindahan stok setengah jadi → barang jadi giftbox. |

### Assembling

| Bagian | Status | Rincian |
|---|---|---|
| Per orang × 4 varian + TOTAL per varian + TOTAL PRODUK JADI | Format sama, **perilaku beda** | Di ERP total selalu = jumlah per orang. JPG lama membolehkan per orang kosong tapi total 2.800. |
| BMR (titik borongan) sebagai "orang" | Kurang di ERP | Di ERP, BMR bisa diketik sebagai nama baris, tapi **tidak terhubung** ke setoran hasil borongan (`/borongan`, `HSB:`). Kalau hasil BMR juga disetor lewat Borongan, ada risiko dihitung dua kali bila nanti laporan shift dihubungkan ke stok. |
| Checklist 6 tugas berfoto, 0/6 tetap terkirim | Sama (dan itu masalahnya) | Lihat keputusan D. |
| Stok 24 bahan (gendel, pack, boks, kg) + order | Sama | Persis `DIVISION_SETUP.ASSEMBLING`. |
| Produk jadi → stok barang jadi + HPP resep | **Tidak tercatat** | Hanya JSON. Barang jadi baru masuk stok bila diinput di Produksi tahap Barang Jadi (`postProductionStock`, nilai dari resep #72). |
| Upah borongan assembling per orang | Tidak tercatat | Gaji borongan (`payroll.ts`) membaca `ProductionEntry` per karyawan, bukan laporan shift. |

---

## 2. Ke mana angka laporan masuk (poin e, paling penting untuk akuntansi)

| Angka di laporan | Masuk ke | Status |
|---|---|---|
| Panen (oven × varian) | Produksi / stok setengah jadi / avgCost | **Tidak masuk.** Hanya JSON di `ShiftReport.work`. |
| Hasil cetak per orang | Kinerja / gaji borongan | **Tidak masuk.** Gaji borongan membaca `ProductionEntry`. |
| Assembling produk jadi | Stok barang jadi + HPP resep | **Tidak masuk.** |
| Packing resi/patung | Keluar barang jadi / HPP marketplace | **Tidak masuk.** |
| Giftbox | Stok barang jadi giftbox | **Tidak masuk.** |
| Stok akhir shift | Stock opname bahan → akun HPP "Pemakaian Bahan Baku" | **Masuk** (saat laporan dikirim; lihat bug tanggal). |
| Order bahan | Permintaan/pembelian otomatis | **Tidak.** Hanya daftar (`/laporan/order`) + teks di pesan bot. Tidak membuat Permintaan stok, tidak ada pengingat ke bagian pembelian. |
| Target | Capaian | **Tidak dibaca.** |

**Hitung dobel?** Saat ini **tidak**, karena satu-satunya yang masuk akuntansi dari laporan adalah stock opname bahan. Bahan yang sudah dikonsumsi oleh input Produksi tahap Cetak (resep → BDP) mengurangi stok sistem lebih dulu, jadi selisih opname tinggal sisanya. Total kredit persediaan bahan tetap = pemakaian nyata.

**Tidak tercatat sama sekali?** **Ya**, untuk semua hasil kerja (panen, cetak, assembling, giftbox, packing), kecuali bila seseorang juga menginput manual di menu Produksi. Akibatnya stok setengah jadi/barang jadi dan HPP per unit bergantung pada input Produksi terpisah + opname akhir bulan.

**Risiko dobel bila nanti dihubungkan:** jika laporan shift membuat `ProductionEntry` otomatis, sementara tim juga menginput Produksi manual atau setoran Borongan (BMR), hasil akan tercatat dua kali. Jadi harus dipilih **satu sumber** (lihat keputusan A).

---

## 3. Bug yang terbukti di kode (urut prioritas)

1. **Opname memakai waktu kirim, bukan waktu laporan** (`laporan/actions.ts`, `applyStockCount(..., new Date())`). Laporan yang terlambat dikirim bisa menghapus pembelian atau mengembalikan stok ke hitungan lama. Berdampak ke jurnal HPP Pemakaian Bahan Baku.
2. **Peringatan Beranda "laporan kemarin belum dikirim" salah hitung** (`alerts.ts`): shift × divisi, tidak memakai `shiftCount` per divisi. Peringatan palsu setiap hari.
3. **Rekap harian bot hanya menghitung laporan yang sudah dibuat** (`jobs.ts`); laporan yang tidak dibuat tidak terlihat.
4. Stock opname tetap diterapkan walau pengiriman Telegram GAGAL (kecil).
5. Lebar JPG 900 px, bukan 1000 px sesuai aturan (kecil; slip & nota juga 900).

---

## 4. Usulan perbaikan berprioritas

**P1 (wajib, kecil, aman)**
1. Pindahkan tim ke laporan ERP (bukan aplikasi lama), supaya stok akhir menjadi opname dan order bahan tercatat. Ini keputusan user (B).
2. Perbaiki tanggal opname: pakai tanggal laporan + jam akhir shift. Untuk hitungan pertama, bandingkan dengan stok sistem **per jam akhir shift** (mutasi sesudahnya tidak ikut). Tolak/beri peringatan bila sudah ada laporan lebih baru untuk divisi yang sama.
3. Perbaiki hitungan peringatan "belum dikirim" (pakai `shiftCount` per divisi, hanya divisi yang punya format laporan) dan rekap bot (hitung juga yang belum dibuat).

**P2 (sedang)**
4. Aturan kelengkapan sebelum kirim (lihat keputusan D): minimal peringatan "Checklist 0/6, 6 foto belum ada. Tetap kirim?" + tanda merah di pesan Owner.
5. Kirim JPG laporan otomatis ke grup/penerima saat "Kirim laporan" (pakai `renderDocJpg` yang sudah ada), tidak hanya teks.
6. Ringkasan Giftbox: tampilkan "Total giftbox: 99 box"; sembunyikan resi bila 0/kosong (keputusan G).
7. Target & capaian di laporan: baca `ProductionTarget` (atau target baru per divisi/shift), tampilkan "Target X · capaian Y%" dan tanda merah bila di bawah target.
8. Reject + alasan di laporan Produksi (panen) memakai daftar `REJECT_REASONS` yang sudah ada.

**P3 (besar, perlu keputusan A dulu)**
9. Hubungkan hasil kerja ke stok/HPP dengan satu sumber data (keputusan A).
10. Order bahan → buat Permintaan stok otomatis (status Diajukan) atau pengingat bot ke Owner/Admin (keputusan E).
11. Assembling: baris "BMR/Mastrip" diambil dari setoran Borongan (baca-saja) agar tidak diketik ulang dan tidak dobel.
12. Rekap mingguan/bulanan laporan shift (panen, cetak, assembling, giftbox, packing per hari) + unduh JPG/Excel. Rekap sekarang (`/laporan/rekap`) hanya membaca `ProductionEntry`.
13. Lebar JPG 1000 px (bila user mau mengikuti aturan secara ketat).

---

## 5. Pertanyaan keputusan untuk user (opsi + rekomendasi)

**A. Hasil kerja di laporan shift masuk ke stok & HPP?**
- A1. Ya, laporan shift jadi **satu-satunya** sumber hasil produksi: saat dikirim otomatis membuat entri Produksi (panen → setengah jadi, assembling → barang jadi + HPP resep, packing → keluar barang jadi). Input Produksi manual untuk hal yang sama dimatikan.
- A2. Tidak, laporan shift tetap laporan saja; hasil produksi tetap diinput terpisah di menu Produksi.
- A3. Sebagian dulu: hanya **Assembling → stok barang jadi** (paling berpengaruh ke HPP), lainnya menyusul.
- **Rekomendasi: A3**, lalu A1 bertahap. Paling cepat memperbaiki HPP tanpa risiko dobel besar.

**B. Kapan tim pindah dari aplikasi lama ke laporan ERP?**
- B1. Mulai besok, aplikasi lama berhenti.
- B2. Jalan berdampingan 1 minggu, lalu berhenti.
- B3. Setelah perbaikan P1 & P2 selesai.
- **Rekomendasi: B3** (setelah bug tanggal opname diperbaiki), karena laporan yang terlambat dikirim bisa merusak stok.

**C. Total assembling boleh diketik manual (tanpa per orang)?**
- C1. Tidak, total selalu jumlah per orang (seperti ERP sekarang).
- C2. Boleh, tapi muncul peringatan bila beda dengan jumlah per orang.
- C3. Per orang hanya untuk karyawan; hasil BMR/Mastrip diambil otomatis dari setoran Borongan.
- **Rekomendasi: C1 + C3.**

**D. Checklist dan foto saat kirim laporan**
- D1. Wajib lengkap: tidak bisa kirim sebelum semua foto/centang.
- D2. Boleh kirim, tapi wajib alasan untuk yang belum + ditandai merah ke Owner.
- D3. Bebas seperti sekarang.
- **Rekomendasi: D2** (tidak menghambat shift, tapi Owner tahu).

**E. Order bahan baku**
- E1. Otomatis membuat Permintaan stok (Diajukan) untuk bahan ≤ limit.
- E2. Hanya pengingat bot ke Owner/Admin setiap pagi.
- E3. Seperti sekarang (daftar saja).
- **Rekomendasi: E2** dulu (ringan); E1 bila sudah rutin.

**F. Target**
- F1. Target per divisi per shift (mis. panen 2.400/shift), tampil capaian % di laporan.
- F2. Target per orang (cetak/assembling).
- F3. Tidak perlu.
- **Rekomendasi: F1** (pakai tabel `ProductionTarget` yang sudah ada).

**G. Ringkasan Giftbox**
- G1. "Total giftbox: 99 box | Total patung: 495 pcs" (resi dihapus dari Giftbox).
- G2. "Total resi | Total giftbox | Total patung".
- **Rekomendasi: G2**, resi tetap ada tapi hanya tampil bila diisi.

**H. Lebar JPG**
- H1. Ubah ke 1000 px sesuai aturan (laporan shift, slip, nota).
- H2. Biarkan 900 px.
- **Rekomendasi: H1** (sekalian di P1, perubahan kecil).

---

## 6. Perintah VPS (baca-saja)

Jalankan di tab **"VPS magy"**. Tidak mengubah data.

1. Laporan shift ERP 1–10 Nov (apakah tim memakai ERP?):
```bash
sudo -u postgres psql maingypsum -c "SELECT r.date, d.name AS divisi, s.name AS shift, r.status, r.\"picName\", r.\"stockApplied\", (SELECT count(*) FROM \"ReportSend\" x WHERE x.\"reportId\"=r.id) AS kirim FROM \"ShiftReport\" r JOIN \"Division\" d ON d.id=r.\"divisionId\" JOIN \"Shift\" s ON s.id=r.\"shiftId\" WHERE r.date >= '2026-11-01' ORDER BY r.date, d.name, s.name;"
```

2. Input Produksi 1–10 Nov per tanggal & tahap:
```bash
sudo -u postgres psql maingypsum -c "SELECT date, stage, count(*) AS entri, sum(\"qtyGood\") AS baik, sum(\"qtyReject\") AS reject FROM \"ProductionEntry\" WHERE date >= '2026-11-01' GROUP BY date, stage ORDER BY date, stage;"
```

3. Bahan baku per divisi (apakah Magnet & Refill lem tembak sudah ada):
```bash
sudo -u postgres psql maingypsum -c "SELECT d.name AS divisi, i.name, i.unit, i.\"minStock\", i.active FROM \"Item\" i JOIN \"Division\" d ON d.id=i.\"divisionId\" WHERE i.type='BAHAN_BAKU' ORDER BY d.name, i.\"sortOrder\", i.name;"
```

4. Stock opname dari laporan shift yang sudah dibukukan:
```bash
sudo -u postgres psql maingypsum -c "SELECT date::date AS tgl, count(*) AS mutasi FROM \"StockMovement\" WHERE ref LIKE 'LAP:%' GROUP BY 1 ORDER BY 1;"
```

5. Target produksi yang aktif:
```bash
sudo -u postgres psql maingypsum -c "SELECT d.name AS divisi, t.stage, t.\"dailyQty\", t.\"employeeId\" IS NOT NULL AS per_orang FROM \"ProductionTarget\" t JOIN \"Division\" d ON d.id=t.\"divisionId\" WHERE t.active ORDER BY d.name;"
```
