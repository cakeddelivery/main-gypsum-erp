/*
 * Pasang resep (bahan + upah) barang hasil yang belum punya resep: hasil tugas borongan (mis. Single Pack, Cat Plastik) dan
 * Patung kering <karakter> = 1 Patung cetak. Resep/BOM yang sudah ada TIDAK ditimpa.
 *   npm run hpp:resep-dari-tugas                 -> pratinjau
 *   npm run hpp:resep-dari-tugas -- --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 */
import { PrismaClient } from "@prisma/client";
import { pasangResepDariTugas } from "../src/lib/hppNilai";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
pasangResepDariTugas(prisma, apply)
  .then(({ plan, sudahAda }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    for (const p of plan) console.log(`\n${p.sku} ${p.name} [${p.why}]\n  ${p.lines.join("\n  ")}`);
    console.log(`\n${plan.length} barang diberi resep. Sudah punya resep/BOM (tidak diubah): ${sudahAda.length}`);
    if (sudahAda.length) console.log("  " + sudahAda.join("\n  "));
    if (!apply && plan.length) console.log("\nBila sudah sesuai (setelah npm run backup): npm run hpp:resep-dari-tugas -- --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
