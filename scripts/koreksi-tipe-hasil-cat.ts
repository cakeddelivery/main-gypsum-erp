/*
 * KOREKSI TIPE hasil Cat Plastik & Cat Giftbox menjadi barang SETENGAH JADI (BARANG_DALAM_PROSES):
 *   npm run koreksi:tipe-hasil-cat                          -> PREVIEW (tidak mengubah data)
 *   npm run backup && npm run koreksi:tipe-hasil-cat -- --jalankan [--tanpa-jurnal]
 * Item hasil tugas "Cat plastik …" / "Cat giftbox" yang bukan setengah jadi (biasanya Cat plastik merah/biru/kuning = BAHAN_BAKU) diubah:
 *  - tipe → BARANG_DALAM_PROSES, kategori Barang Setengah Jadi, divisi = divisi tugas bila masih kosong;
 *  - stok di gudang bahan baku → dipindah ke gudang setengah jadi (TRANSFER, total tidak berubah; stok titik/driver tidak disentuh);
 *  - jurnal reklasifikasi Dr Persediaan Barang Dalam Proses / Cr Persediaan Bahan (nilai = jumlah × harga pokok); --tanpa-jurnal melewatinya.
 * Tanpa migrasi. Aman diulang. Setelah ini item itu ikut hitungan stok akhir hasil & limit "perlu diproduksi" divisinya.
 */
import { prisma } from "../src/lib/db";
import { applyTipeHasil, planTipeHasil } from "../src/lib/koreksiTipeHasil";

const run = process.argv.includes("--jalankan");
const n = (x: number) => x.toLocaleString("id-ID");

async function main() {
  const rows = await planTipeHasil();
  console.log(`${run ? "EKSEKUSI" : "PREVIEW (tidak mengubah data)"} · hasil Cat yang bukan barang setengah jadi: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.sku} ${r.name} · tipe ${r.fromType} → BARANG_DALAM_PROSES · tugas "${r.task}"`);
    console.log(`     stok total ${n(r.qtyTotal)} (di gudang bahan baku ${n(r.qtyRaw)} → dipindah ke gudang setengah jadi) · nilai Rp${n(r.value)}${r.value ? " → jurnal reklasifikasi" : ""}`);
    console.log(`     divisi barang: ${r.itemDivision ?? "(kosong)"}${r.setDivision ? ` → diisi ${r.division}` : ""} · divisi tugas: ${r.division ?? "-"}`);
  }
  if (!rows.length) return console.log("Semua hasil Cat sudah barang setengah jadi. Tidak ada yang perlu dikoreksi.");
  if (!run) return console.log("\nPreview saja. Jalankan: npm run backup && npm run koreksi:tipe-hasil-cat -- --jalankan");
  const r = await applyTipeHasil({ id: "system", name: "koreksi-tipe-hasil-cat" }, { jurnal: !process.argv.includes("--tanpa-jurnal") });
  console.log(`\nSELESAI. ${r.items} barang dikoreksi, ${r.moved} stok dipindah gudang, ${r.journals} jurnal reklasifikasi.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
