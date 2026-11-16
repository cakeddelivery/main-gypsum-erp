/*
 * Isi awal kit bahan pendukung per tugas borongan (Assembling, Cat Giftbox, Cat Plastik) untuk form Kirim Bahan.
 *   npm run setup:kit-tugas                 -> pratinjau (tidak menyimpan apa pun)
 *   npm run setup:kit-tugas -- --jalankan   -> menyimpan
 * Setelah itu kit bisa diubah di Borongan → Tugas & Tarif → Ubah tugas.
 */
import { prisma } from "../src/lib/db";
import { setupTaskKits } from "../src/lib/boronganSetup";

const apply = process.argv.includes("--jalankan");
setupTaskKits(prisma, apply)
  .then((log) => {
    console.log(apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)");
    for (const l of log) console.log("  " + l);
    if (!apply) console.log("\nBila sudah sesuai, jalankan: npm run setup:kit-tugas -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
