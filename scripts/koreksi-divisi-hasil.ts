/*
 * Perbaiki divisi penanggung jawab barang jadi agar muncul di "Stok akhir" laporan shift:
 * Single Pack per karakter → Packing, barang jadi Giftbox → Giftbox.
 *   npm run koreksi:divisi-hasil                 -> pratinjau
 *   npm run koreksi:divisi-hasil -- --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 */
import { PrismaClient } from "@prisma/client";
import { koreksiDivisiHasil } from "../src/lib/koreksiDivisiHasil";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
koreksiDivisiHasil(prisma, apply)
  .then(({ fixes, ok, noDivision }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    for (const f of fixes) console.log(`  ${f.sku}  ${f.name}: ${f.from ?? "(tanpa divisi)"} → ${f.to}  [${f.why}]`);
    console.log(`\n${fixes.length} barang diubah, ${ok} sudah benar.`);
    if (noDivision.length) console.log(`Divisi template ${noDivision.join(", ")} tidak ditemukan; barangnya dilewati.`);
    if (!apply && fixes.length) console.log("\nBila sudah sesuai (setelah npm run backup): npm run koreksi:divisi-hasil -- --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
