/*
 * Divisi Oven: Shift 1 & Shift 2 seperti Cetak (jadwal S1/S2, deteksi shift dari jam masuk).
 *   npm run setup:shift-oven                 -> PRATINJAU
 *   npm run setup:shift-oven -- --jalankan   -> menyimpan
 */
import { prisma } from "../src/lib/db";
import { setupOvenShift } from "../src/lib/shiftOvenSetup";

const apply = process.argv.includes("--jalankan");
setupOvenShift(prisma, apply)
  .then((log) => {
    console.log(apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)");
    for (const l of log) console.log("  " + l);
    if (!apply) console.log("\nBila sudah sesuai, jalankan: npm run setup:shift-oven -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
