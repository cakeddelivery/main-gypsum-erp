/*
 * Audit (HANYA MEMBACA) daftar "Stok akhir setengah jadi / produk jadi" per divisi laporan shift:
 *   npm run cek:stok-akhir-divisi
 * Menampilkan jumlah barang per divisi, barang keluaran tugas borongan divisi yang divisi barangnya berbeda (kini tetap masuk daftar divisi penerima),
 * dan barang berstok yang tidak dihitung divisi mana pun (perlu Divisi penanggung jawab di Master barang / koreksi:divisi-hasil).
 */
import { prisma } from "../src/lib/db";
import { auditStokAkhirDivisi } from "../src/lib/shiftResultCount";

(async () => {
  const a = await auditStokAkhirDivisi(prisma);
  console.log("STOK AKHIR PER DIVISI\n");
  for (const d of a.divisi) {
    console.log(`${d.nama} (${d.template}): ${d.jumlah} barang`);
    for (const x of d.lewatKeluaranTugas) console.log(`   + ${x.sku} ${x.nama} — keluaran tugas divisi ini, Item.divisionId kosong (ikut dihitung divisi ini)`);
    for (const x of d.keluaranDivisiLain) console.log(`   ! ${x.sku} ${x.nama} — keluaran tugas divisi ini, tetapi Item.divisionId = ${x.divisiItem} (TIDAK muncul di form ${d.nama}; perbaiki divisi barang)`);
  }
  console.log(`\nBARANG BERSTOK YANG TIDAK DIHITUNG DIVISI MANA PUN: ${a.yatim.length}`);
  for (const x of a.yatim.slice(0, 60)) console.log(`   ${x.sku} ${x.nama} [${x.tipe}] stok ${x.qty} · divisi barang: ${x.divisiItem ?? "(kosong)"}`);
  if (a.yatim.length) console.log("\nPerbaikan data (pratinjau dulu): npm run koreksi:divisi-hasil");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
