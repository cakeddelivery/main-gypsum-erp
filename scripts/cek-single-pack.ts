/**
 * Diagnosa READ-ONLY barang Single Pack per series (Hewan, Cowok, Cewek, Transportasi):
 * semua barang kandidat + tipe, divisi, stok per lokasi, mutasi, dan pemakaian (produk katalog, flowItem laporan shift,
 * resep/BOM, tugas borongan, isi laporan shift). Tidak mengubah apa pun.
 *
 *   npm run single-pack:cek
 */
import { prisma } from "../src/lib/db";
import { diagLines, diagnoseSinglePack } from "../src/lib/singlePackDiag";

diagnoseSinglePack()
  .then((d) => {
    console.log("DIAGNOSA SINGLE PACK (read-only, tidak ada yang diubah)");
    for (const l of diagLines(d)) console.log(l);
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
