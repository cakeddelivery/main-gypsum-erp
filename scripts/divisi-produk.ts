/*
 * Isi divisi penanggung jawab barang setengah jadi & produk jadi (aktif, yang belum punya divisi) sesuai aturan bawaan.
 *   npm run setup:divisi-produk                 -> pratinjau
 *   npm run setup:divisi-produk -- --jalankan   -> menyimpan
 * Sesudahnya bisa diubah per barang atau massal di Stok → Master data.
 */
import { PrismaClient } from "@prisma/client";
import { setupItemDivisions } from "../src/lib/itemDivisionSetup";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
setupItemDivisions(prisma, apply)
  .then(({ plan, skipped, kept }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    const by = new Map<string, string[]>();
    for (const p of plan) by.set(p.division, [...(by.get(p.division) ?? []), p.name]);
    for (const [d, names] of by) console.log(`\n${d} (${names.length}):\n  ${names.join("\n  ")}`);
    if (skipped.length) console.log(`\nTidak cocok aturan, dibiarkan tanpa divisi (${skipped.length}):\n  ${skipped.join("\n  ")}`);
    if (kept.length) console.log(`\nSudah punya divisi, tidak diubah: ${kept.length} barang`);
    if (!apply) console.log("\nBila sudah sesuai: npm run setup:divisi-produk -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
