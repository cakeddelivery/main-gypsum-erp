/**
 * Perbaiki grup "Satuan Single Pack" di laporan Packing: samakan barang jadi produk katalog (Hewan, Cowok, Cewek,
 * Transportasi) dengan barang yang dipakai laporan shift.
 *
 *   npm run single-pack:tautkan                 → pratinjau (tidak mengubah apa pun)
 *   npm run single-pack:tautkan -- --jalankan   → simpan (jalankan npm run backup dulu)
 *
 * Hanya mengubah tautan Product.finishedItemId. Tidak menghapus data, tidak menyentuh stok/jurnal. Aman diulang.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { applySinglePackLinks, planSinglePackLinks } from "../src/lib/singlePackFix";

const run = process.argv.includes("--jalankan");
class Rollback extends Error {}

async function main() {
  console.log(run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)");
  try {
    await prisma.$transaction(async (tx) => {
      const plans = await planSinglePackLinks(tx);
      for (const p of plans) {
        console.log(`\n${p.variant.padEnd(13)} [${p.action.toUpperCase()}] ${p.note}`);
        if (p.duplicates.length > 1) console.log(`   Barang/produk Single Pack ${p.variant} (${p.duplicates.length}):\n   - ${p.duplicates.join("\n   - ")}`);
      }
      const n = await applySinglePackLinks(tx, plans);
      console.log(`\n${n} produk ditautkan ulang.`);
      if (!run) throw new Rollback();
    }, { timeout: 60000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    console.log("Tersimpan. Buka lagi laporan Packing untuk memeriksa.");
  } catch (e) {
    if (e instanceof Rollback) console.log("\nBelum ada yang diubah.");
    else throw e;
  }
}
main().finally(() => prisma.$disconnect());
