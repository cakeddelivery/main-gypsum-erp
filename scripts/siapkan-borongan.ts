/*
 * Siapkan borongan sesuai alur lapangan: titik BERINGIN (Cat Plastik), tugas Assembling per karakter & Cat Plastik per warna,
 * barang Pot cat giftbox & Cat plastik merah/biru/kuning, paket bahan & tugas per titik.
 *   npm run setup:borongan                 -> pratinjau (tidak menyimpan apa pun)
 *   npm run setup:borongan -- --jalankan   -> menyimpan (jalankan npm run backup dulu)
 */
import { PrismaClient } from "@prisma/client";
import { setupBorongan } from "../src/lib/boronganSetup";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
setupBorongan(prisma, apply)
  .then((log) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    for (const l of log) console.log("  " + l);
    if (!apply) console.log("\nBila sudah sesuai, jalankan: npm run setup:borongan -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
