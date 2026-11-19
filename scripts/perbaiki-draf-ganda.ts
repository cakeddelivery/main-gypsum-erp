/*
 * Draf laporan shift di divisi 2 shift untuk shift yang tidak ada karyawannya (mis. Oven 1 orang: draf Shift 1/2 ganda).
 *   npm run perbaiki:draf-ganda                 -> PRATINJAU (tidak menyimpan apa pun)
 *   npm run perbaiki:draf-ganda -- --jalankan   -> menghapus draf KOSONG saja (jalankan npm run backup dulu)
 * Draf yang sudah berisi data (checklist, hasil, stok, barang masuk, kendala) HANYA dilaporkan, tidak dihapus.
 */
import { prisma } from "../src/lib/db";
import { deleteEmptyExtraDrafts, findExtraDrafts } from "../src/lib/reportShift";

const apply = process.argv.includes("--jalankan");
(async () => {
  const items = await findExtraDrafts(60);
  const empty = items.filter((i) => i.empty);
  console.log(`${apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)"}: ${items.length} draf di shift tanpa karyawan (${empty.length} kosong, ${items.length - empty.length} berisi data)`);
  for (const i of items) console.log("  " + i.label);
  if (apply && empty.length) console.log(`  ${await deleteEmptyExtraDrafts(items, { id: "script", name: "Skrip perbaikan draf ganda" })} draf kosong dihapus`);
  if (!apply && empty.length) console.log("\nBila sudah sesuai, jalankan: npm run perbaiki:draf-ganda -- --jalankan");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
