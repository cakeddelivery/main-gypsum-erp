/*
 * Reklas pembelian LPG oven yang sudah terposting ke beban lain (mis. 6-1300 Beban Listrik, Air & Gas) ke 6-1310 Beban LPG Produksi (BOP).
 * Jurnal reklas Dr 6-1310 / Cr akun lama per transaksi (bertanggal transaksi); transaksi TIDAK diubah/dihapus. Idempoten.
 *   npm run koreksi:lpg-reklas                 -> pratinjau
 *   npm run koreksi:lpg-reklas -- --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 */
import { PrismaClient } from "@prisma/client";
import { lpgReklas } from "../src/lib/lpgReklas";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
lpgReklas(prisma, apply)
  .then(({ rows, journals, gagal, akunAda }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    if (!akunAda) console.log("Akun 6-1310 belum ada (jalankan migrasi terbaru). Tidak ada yang dikoreksi.");
    for (const r of rows) console.log(`  ${r.number} (${r.date.toISOString().slice(0, 10)}): ${rp(r.amount)} dari ${r.akun} ${r.akunNama} → 6-1310 · ${r.teks.slice(0, 70)}`);
    console.log(`\n${rows.length} transaksi${apply ? `, ${journals} jurnal dibuat` : " akan direklas"}; total ${rp(rows.reduce((a, r) => a + r.amount, 0))}.`);
    for (const g of gagal) console.log(`⚠ ${g}`);
    if (!apply && rows.length) console.log("\nBila sudah sesuai (setelah npm run backup): tambahkan --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
