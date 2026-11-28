/*
 * Rekonsiliasi persediaan (HANYA MEMBACA): saldo buku besar 1-1401 / 1-1402 / 1-1403 vs nilai stok (Σ qty × avgCost per tipe).
 *   npm run cek:rekonsiliasi-persediaan
 * Menampilkan selisih per akun, rincian penyebab per baris (transaksi Finance debit persediaan tanpa stok masuk, penerimaan stok tanpa jurnal)
 * beserta usulan koreksi, dan sisa yang belum terjelaskan. Koreksi: npm run koreksi:rekonsiliasi-persediaan (pratinjau dulu).
 */
import { prisma } from "../src/lib/db";
import { diagnosaSisa, rekonPersediaan } from "../src/lib/rekonPersediaan";
import { planLpgReklasFull } from "../src/lib/lpgReklas";

const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");
(async () => {
  const r = await rekonPersediaan(prisma);
  console.log("REKONSILIASI PERSEDIAAN: buku besar vs nilai stok\n");
  console.log(`Akun beban LPG (untuk pembelian LPG yang dicatat ke persediaan): ${r.lpgAccount ? `${r.lpgAccount.code} ${r.lpgAccount.name}` : "BELUM ADA (buat akun beban LPG / kategori transaksi LPG agar baris LPG bisa direklas)"}\n`);
  for (const a of r.accounts) {
    console.log(`${a.code} ${a.name}: buku besar ${rp(a.gl)} · nilai stok ${rp(a.stock)} · selisih ${rp(a.diff)}`);
    console.log(`   terjelaskan ${rp(a.terjelaskan)} · SISA belum terjelaskan ${rp(a.sisa)}`);
    const rows = r.rows.filter((x) => x.account === a.code);
    for (const k of ["FINANCE_TANPA_STOK", "PENERIMAAN_TANPA_JURNAL"] as const) {
      const g = rows.filter((x) => x.kelompok === k);
      if (!g.length) continue;
      console.log(`   [${k === "FINANCE_TANPA_STOK" ? "Transaksi Finance debit persediaan tanpa stok masuk" : "Penerimaan stok tanpa jurnal"}] ${g.length} baris, total ${rp(g.reduce((s, x) => s + x.gap, 0))}`);
      for (const x of g) console.log(`      ${x.ref} (${day(x.date)}): ${rp(x.gap)} · ${x.detail}${x.lpgPart ? ` · LPG Rp${x.lpgPart.toLocaleString("id-ID")}` : ""}${x.lpgNote ? ` · ⚠ ${x.lpgNote}` : ""}\n         usul: ${x.usul}`);
    }
  }
  // Diagnosis sisa: nilai mutasi stok vs nilai jurnal per jenis referensi (jurnal − mutasi; positif = buku besar lebih tinggi)
  const d = await diagnosaSisa(prisma);
  console.log("\nDIAGNOSIS SISA per jenis referensi stok (mutasi = qty × harga mutasi; jurnal = saldo jurnal pada akun itu):");
  for (const a of r.accounts) {
    console.log(`  ${a.code} ${a.name}  (Σ mutasi − nilai stok sekarang: ${rp(d.nilaiStokVsMutasi[a.code] ?? 0)})`);
    for (const x of d.rows.filter((y) => y.account === a.code && Math.abs(y.selisih) > 1000)) console.log(`     ${x.group.padEnd(18)} mutasi ${rp(x.mutasi).padStart(18)} · jurnal ${rp(x.jurnal).padStart(18)} · selisih ${rp(x.selisih)}`);
  }
  console.log(`  Bagian TERBUKTI (1-1401 terlalu tinggi & 1-1403 terlalu rendah pada jenis referensi yang sama): ${rp(d.antar.total)} · sudah dikoreksi ${rp(d.antar.sudah)} · sisa ${rp(d.antar.sisa)}`);
  for (const g of d.antar.perGrup.slice(0, 10)) console.log(`     ${g.group}: ${rp(g.amount)}`);
  if (d.antar.sisa > 1000) console.log("  Usulan (pratinjau dulu): npm run koreksi:rekonsiliasi-persediaan -- --sisa=reklas-antar-persediaan   (Cr 1-1401 / Dr 1-1403)");
  const { rows: lpg, manual } = await planLpgReklasFull(prisma);
  for (const m of manual) console.log(`\n⚠ LPG perlu cek manual ${m.number}: ${m.alasan}`);
  if (lpg.length) {
    console.log(`\nINFO: ${lpg.length} transaksi LPG sudah terposting ke beban lain (bukan 6-1310 BOP), total ${rp(lpg.reduce((a, x) => a + x.amount, 0))}:`);
    for (const x of lpg) console.log(`   ${x.number} (${day(x.date)}): ${rp(x.amount)} di ${x.akun} ${x.akunNama} · ${x.teks.slice(0, 60)}`);
    console.log("   Reklas opsional (jurnal, transaksi tidak diubah): npm run koreksi:lpg-reklas");
  }
  console.log("\nKoreksi (jurnal penyesuaian, tidak menghapus transaksi): npm run koreksi:rekonsiliasi-persediaan");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
