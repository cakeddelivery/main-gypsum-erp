/*
 * Revaluasi harga rata-rata (avgCost) barang setengah jadi / jadi yang masih Rp 0 menjadi harga resep (bahan + upah borongan + overhead resep, sama dengan HPP di Produk & HPP).
 * Selisih nilai persediaan dijurnal ke Beban Selisih Persediaan (6-1800), satu transaksi, idempoten, ada audit.
 *   npm run hpp:revaluasi                              -> pratinjau (barang, harga lama → baru, qty, selisih Rp)
 *   npm run hpp:revaluasi -- --jalankan                -> menyimpan (jalankan `npm run backup` dulu)
 *   --termasuk-tidak-wajar                             -> ikut barang yang harganya ada tapi >2× / <0,5× harga resep
 */
import { PrismaClient } from "@prisma/client";
import { revaluasiAvgCost } from "../src/lib/hppNilai";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const tidakWajar = process.argv.includes("--termasuk-tidak-wajar");
const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(n).toLocaleString("id-ID")}`;
revaluasiAvgCost(prisma, apply, { tidakWajar })
  .then(({ rows, skipped, journalId }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    let sum = 0;
    for (const r of rows) {
      sum += r.delta;
      console.log(`  ${r.sku} ${r.name} · stok ${r.qty.toLocaleString("id-ID")} · ${rp(r.old)} → ${rp(r.target)} (${r.source})${r.wajar ? "" : " [tidak wajar]"} · selisih ${rp(r.delta)}`);
    }
    console.log(`\n${rows.length} barang, total selisih nilai persediaan ${rp(sum)} (→ Beban Selisih Persediaan)${journalId ? ` · jurnal ${journalId}` : ""}`);
    if (skipped) console.log(`${skipped} barang harganya ada tapi menyimpang dari resep: tidak diubah (pakai --termasuk-tidak-wajar bila perlu)`);
    if (!apply && rows.length) console.log("\nBila sudah sesuai (setelah npm run backup): npm run hpp:revaluasi -- --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
