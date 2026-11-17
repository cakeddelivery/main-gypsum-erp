/*
 * Data master produk & HPP: setengah jadi hasil borongan (Cat Plastik, Cat Giftbox, Single Pack), produk jadi
 * Paket 12/24 & Giftbox, resep + upah borongan, konversi satuan (kg→g, strip→pcs).
 *   npm run setup:produk-hpp                 -> PRATINJAU (tidak menyimpan apa pun)
 *   npm run setup:produk-hpp -- --jalankan   -> menyimpan
 * Konversi stok lama (boks → satuan beli baru), opsional: stok × faktor, harga ÷ faktor, nilai persediaan tetap
 *   -- --konversi-klip=0.5 --konversi-cottonbud=2 --konversi-piring=0.8
 * Tidak menghapus / menggabung barang: yang bentrok/dobel hanya dilaporkan untuk dikonfirmasi Owner.
 */
import { prisma } from "../src/lib/db";
import { setupProdukHpp } from "../src/lib/produkHppSetup";

const apply = process.argv.includes("--jalankan");
const factor = (name: string) => {
  const a = process.argv.find((x) => x.startsWith(`--konversi-${name}=`));
  if (!a) return undefined;
  const n = Number(a.split("=")[1].replace(",", "."));
  if (!(n > 0)) throw new Error(`Faktor ${a} tidak valid (harus angka > 0)`);
  return n;
};
const konversi = { klip: factor("klip"), cottonbud: factor("cottonbud"), piring: factor("piring") };
const TITLE = { dibuat: "BARANG DIBUAT", diubah: "BARANG DIUBAH (tipe / divisi / satuan / stok)", resep: "RESEP & UPAH BORONGAN DIPASANG", bentrok: "BENTROK / DOBEL (perlu konfirmasi Owner)", menunggu: "MENUNGGU KONFIRMASI / DATA BELUM ADA", info: "INFORMASI (satuan & stok terkini, pemakaian kode)" } as const;
setupProdukHpp(prisma, apply, konversi)
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
