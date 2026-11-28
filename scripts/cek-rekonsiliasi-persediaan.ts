/*
 * Rekonsiliasi persediaan (HANYA MEMBACA): saldo buku besar 1-1401 / 1-1402 / 1-1403 vs nilai stok (Σ qty × avgCost per tipe).
 *   npm run cek:rekonsiliasi-persediaan
 * Menampilkan selisih per akun, rincian penyebab per baris (transaksi Finance debit persediaan tanpa stok masuk, penerimaan stok tanpa jurnal)
 * beserta usulan koreksi, dan sisa yang belum terjelaskan. Koreksi: npm run koreksi:rekonsiliasi-persediaan (pratinjau dulu).
 */
import { prisma } from "../src/lib/db";
import { rekonPersediaan } from "../src/lib/rekonPersediaan";

const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");
(async () => {
  const r = await rekonPersediaan(prisma);
  console.log("REKONSILIASI PERSEDIAAN: buku besar vs nilai stok\n");
  for (const a of r.accounts) {
    console.log(`${a.code} ${a.name}: buku besar ${rp(a.gl)} · nilai stok ${rp(a.stock)} · selisih ${rp(a.diff)}`);
    console.log(`   terjelaskan ${rp(a.terjelaskan)} · SISA belum terjelaskan ${rp(a.sisa)}`);
    const rows = r.rows.filter((x) => x.account === a.code);
    for (const k of ["FINANCE_TANPA_STOK", "PENERIMAAN_TANPA_JURNAL"] as const) {
      const g = rows.filter((x) => x.kelompok === k);
      if (!g.length) continue;
      console.log(`   [${k === "FINANCE_TANPA_STOK" ? "Transaksi Finance debit persediaan tanpa stok masuk" : "Penerimaan stok tanpa jurnal"}] ${g.length} baris, total ${rp(g.reduce((s, x) => s + x.gap, 0))}`);
      for (const x of g) console.log(`      ${x.ref} (${day(x.date)}): ${rp(x.gap)} · ${x.detail}\n         usul: ${x.usul}`);
    }
  }
  console.log("\nKoreksi (jurnal penyesuaian, tidak menghapus transaksi): npm run koreksi:rekonsiliasi-persediaan");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
