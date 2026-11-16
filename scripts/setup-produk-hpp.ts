/*
 * Data master produk & HPP: setengah jadi hasil borongan (Cat Plastik, Cat Giftbox, Single Pack), produk jadi
 * Paket 12/24 & Giftbox, resep + upah borongan, konversi satuan (kg→g, strip→pcs).
 *   npm run setup:produk-hpp                 -> PRATINJAU (tidak menyimpan apa pun)
 *   npm run setup:produk-hpp -- --jalankan   -> menyimpan
 * Tidak menghapus / menggabung barang: yang bentrok/dobel hanya dilaporkan untuk dikonfirmasi Owner.
 */
import { prisma } from "../src/lib/db";
import { setupProdukHpp } from "../src/lib/produkHppSetup";

const apply = process.argv.includes("--jalankan");
const TITLE = { dibuat: "BARANG DIBUAT", diubah: "BARANG DIUBAH (tipe / divisi / satuan / stok)", resep: "RESEP & UPAH BORONGAN DIPASANG", bentrok: "BENTROK / DOBEL (perlu konfirmasi Owner)", menunggu: "MENUNGGU KONFIRMASI / DATA BELUM ADA" } as const;
setupProdukHpp(prisma, apply)
  .then((plan) => {
    console.log(apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)");
    for (const k of Object.keys(TITLE) as (keyof typeof TITLE)[]) {
      console.log(`\n== ${TITLE[k]} (${plan[k].length}) ==`);
      for (const l of plan[k]) console.log("  " + l);
      if (!plan[k].length) console.log("  —");
    }
    if (!apply) console.log("\nBila sudah sesuai, jalankan: npm run setup:produk-hpp -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
