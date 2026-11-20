/*
 * Tautkan produk katalog "Satuan Single Pack" (Hewan/Cowok/Cewek/Transportasi) ke barang "Single Pack <varian>",
 * agar keempatnya tampil bersama di Laporan Packing › Stok jadi › "Satuan Single Pack".
 *   npm run perbaiki:single-pack                 -> PRATINJAU (tidak menyimpan apa pun)
 *   npm run perbaiki:single-pack -- --jalankan   -> menyimpan (jalankan npm run backup dulu)
 * Hanya mengubah Product.finishedItemId. Barang, stok & riwayat tidak dihapus/dipindah; barang ganda hanya dilaporkan.
 */
import { prisma } from "../src/lib/db";
import { applySinglePackLinks, planSinglePackLinks } from "../src/lib/singlePackLink";

const apply = process.argv.includes("--jalankan");
(async () => {
  const n = await prisma.$transaction(async (tx) => {
    const links = await planSinglePackLinks(tx);
    console.log(apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)");
    for (const l of links) console.log(`  [${l.status}] ${l.text}`);
    return apply ? applySinglePackLinks(tx, links) : links.filter((l) => l.status === "tautkan").length;
  }, { timeout: 60000 });
  console.log(apply ? `\n${n} produk ditautkan.` : `\n${n} produk akan ditautkan. Bila sudah sesuai: npm run backup, lalu npm run perbaiki:single-pack -- --jalankan`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
