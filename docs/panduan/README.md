# Lembar Panduan Divisi

Satu lembar A4 tegak (2480 × 3508 px, 300 dpi) per divisi, dengan kop surat Main Gypsum.

| File | Divisi (format laporan) |
|---|---|
| `panduan-cetak.jpg` | Cetak (CETAK) |
| `panduan-produksi.jpg` | Produksi / Oven (PRODUKSI) |
| `panduan-giftbox.jpg` | Giftbox (GIFTBOX) |
| `panduan-packing.jpg` | Packing (PACKING) |
| `panduan-assembling.jpg` | Assembling (ASSEMBLING) |

Sumber:
- Isi per divisi: `src/lib/panduan.ts`
- Tampilan lembar (HTML/CSS/SVG, kop surat dari `DocSheet`): `src/components/PanduanSheet.tsx` + gaya `.panduan` di `src/app/globals.css`
- Di ERP: **Profil › 📘 Panduan divisi** (`/profil/panduan`) menampilkan panduan divisi pengguna + tombol unduh JPG; divisi lain bisa dipilih.
- Membuat ulang gambar: `U=<username> P=<password> node scripts/panduan-jpg.cjs` saat ERP berjalan.

Bila nama tombol/menu di aplikasi berubah, perbarui `PanduanSheet.tsx` lalu buat ulang gambarnya.
