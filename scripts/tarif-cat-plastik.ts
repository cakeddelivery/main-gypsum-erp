/*
 * Tarif Cat Plastik: bagian koordinator jadi Rp0 (Beringin tidak punya koordinator), budget per pcs turun sebesar itu.
 *   npm run tarif:cat-plastik                 -> pratinjau (tidak menyimpan apa pun)
 *   npm run tarif:cat-plastik -- --jalankan   -> menyimpan (jalankan npm run backup dulu)
 */
import { prisma } from "../src/lib/db";
import { zeroCatPlastikCoordinator } from "../src/lib/boronganSetup";

const apply = process.argv.includes("--jalankan");
zeroCatPlastikCoordinator(prisma, apply)
  .then((log) => {
    console.log(apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)");
    for (const l of log) console.log("  " + l);
    if (!apply) console.log("\nBila sudah sesuai, jalankan: npm run tarif:cat-plastik -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
