/*
 * Hapus baris upah / overhead DOBEL antar tahap resep persis seperti yang dilaporkan `npm run cek:resep-hpp`
 * (UPAH DOBEL, OVERHEAD DOBEL). Baris yang dihapus = di resep tahap berikutnya (produk / setengah jadi pemakai);
 * nilainya tetap dihitung di tahap sebelumnya.
 *   npm run perbaiki:resep-dobel                 -> pratinjau
 *   npm run perbaiki:resep-dobel -- --jalankan   -> menghapus (jalankan `npm run backup` dulu), satu audit
 * Temuan lain di cek:resep-hpp (upah manual, biaya manual lama, faktor overhead) tidak disentuh.
 */
import { PrismaClient } from "@prisma/client";
import { perbaikiResepDobel } from "../src/lib/perbaikiResepDobel";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
perbaikiResepDobel(prisma, apply)
  .then(({ rows, sisa }) => {
    console.log(apply ? "DIHAPUS:" : "PRATINJAU (belum dihapus):");
    for (const r of rows) console.log(`  [${r.kind === "DOBEL_UPAH" ? "UPAH DOBEL" : "OVERHEAD DOBEL"}] ${r.name}: ${r.detail}`);
    console.log(`\n${rows.length} baris${apply ? ` dihapus; sisa temuan dobel: ${sisa}` : ""}.`);
    if (!apply && rows.length) console.log("Bila sudah sesuai (setelah npm run backup): npm run perbaiki:resep-dobel -- --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
