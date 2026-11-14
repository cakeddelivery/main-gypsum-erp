# Lembar Panduan

Satu lembar A4 tegak per divisi dan per role, dengan kop surat Main Gypsum.
- **JPG**: 2480 × 3508 px (300 dpi).
- **PDF**: A4, margin 0, teks vektor.

| Panduan | Untuk | File |
|---|---|---|
| Cetak | Divisi format laporan CETAK | `panduan-cetak.jpg` / `.pdf` |
| Produksi (Oven) | Divisi format PRODUKSI | `panduan-produksi.jpg` / `.pdf` |
| Giftbox | Divisi format GIFTBOX | `panduan-giftbox.jpg` / `.pdf` |
| Packing | Divisi format PACKING | `panduan-packing.jpg` / `.pdf` |
| Assembling | Divisi format ASSEMBLING | `panduan-assembling.jpg` / `.pdf` |
| Supervisor | Role SUPERVISOR | `panduan-supervisor.jpg` / `.pdf` |
| Finance | Role FINANCE | `panduan-finance.jpg` / `.pdf` |
| Owner | Role OWNER | `panduan-owner.jpg` / `.pdf` |
| Semua (8 halaman bernomor) | Owner | `panduan-semua.pdf` |

## Sumber (satu sumber untuk halaman HP, JPG, dan PDF)

- **Isi:** `src/lib/panduan.ts`. Penanda: «Tombol» = nama tombol/menu persis seperti di aplikasi, **tebal**.
- **Izin:** `allowedGuides()` di file yang sama, dicek di server.
  - Anggota/kapten: hanya panduan divisinya (dari data Karyawan).
  - Supervisor/Admin produksi: panduan Supervisor + semua divisi.
  - Finance: panduan Finance.
  - Owner: semua panduan.
- **Halaman HP:** menu **Panduan** (`/panduan`, `src/components/PanduanView.tsx`), dengan tombol:
  - 🖼️ Unduh JPG;
  - 📄 Unduh PDF / Cetak;
  - 📚 Unduh semua (PDF).
- **Lembar A4:** `src/components/PanduanSheet.tsx` + gaya `.panduan`/`.cetak-page` di `src/app/globals.css`.
  - Halaman cetak: `/cetak/panduan?g=<id>` atau `?g=semua`.
  - Di browser: pilih "Simpan sebagai PDF".
- **Gambar layar asli:** `public/panduan/shots/*.png`.
  - Diambil dari aplikasi di HP 390 px, 2×, mode terang, dengan data contoh.
  - Diberi lingkaran merah bernomor pada tombol yang ditekan.

## Membuat ulang

Saat ERP berjalan:

```
U=<username owner> P=<password> node scripts/panduan-jpg.cjs <folder>
```

Hasilnya PNG + PDF per panduan dan `panduan-semua.pdf`. Ubah PNG ke JPG bila perlu.

Bila nama tombol/menu di aplikasi berubah, perbarui `src/lib/panduan.ts`, lalu buat ulang gambar dan gambar layarnya.
