/**
 * Satukan barang Single Pack per series (Hewan, Cowok, Cewek, Transportasi) ke SATU barang "Single Pack <series>"
 * (divisi Packing; dipakai resep/BOM/borongan) — sama pola Transportasi (MG-064):
 *  1) produk katalog Satuan Single Pack → barang Single Pack (flowItem laporan shift ikut)
 *  2) saldo BJ-SAT-<series> per lokasi dipindah lewat penyesuaian berpasangan ref SETUP:SATUKAN-SP
 *     (tanpa jurnal bila nilai rata-rata sama; bila beda, rincian nilai tampil di pratinjau)
 *  3) pemetaan (BOM, komponen resep, peta SKU marketplace, tugas borongan) dialihkan; alias kode lama dibuat
 *  4) BJ-SAT-<series> dinonaktifkan setelah saldo 0 (tidak dihapus; riwayat & dokumen lama tidak diubah)
 *
 *   npm run single-pack:satukan                 → pratinjau (tidak mengubah apa pun)
 *   npm run single-pack:satukan -- --jalankan   → simpan (jalankan npm run backup dulu)
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { applySinglePackMerge, planSinglePackMerge } from "../src/lib/singlePackMerge";

const run = process.argv.includes("--jalankan");
const actor = { id: "script", name: "Skrip satukan Single Pack" };
class Rollback extends Error {}

async function main() {
  console.log(run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)");
  try {
    await prisma.$transaction(async (tx) => {
      const plans = await planSinglePackMerge(tx);
      for (const p of plans) {
        console.log(`\n${p.variant.padEnd(13)} [${p.action.toUpperCase()}] ${p.note}`);
        for (const l of p.lines) console.log(`   - ${l}`);
      }
      const n = await applySinglePackMerge(tx, plans, actor);
      console.log(`\n${n} series ${run ? "disatukan" : "akan disatukan"}.`);
      if (!run) throw new Rollback();
    }, { timeout: 120000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    console.log("Tersimpan. Cek: npm run single-pack:cek (harus 1 barang aktif per series).");
  } catch (e) {
    if (e instanceof Rollback) console.log("\nBelum ada yang diubah. Bila sesuai: npm run backup, lalu npm run single-pack:satukan -- --jalankan");
    else throw e;
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
