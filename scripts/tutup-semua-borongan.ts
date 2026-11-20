/**
 * Tutup administratif SEMUA kiriman borongan yang belum selesai (sebelum cut-over stok dari laporan shift).
 *   npm run borongan:tutup-semua                          → pratinjau (tidak mengubah apa pun)
 *   npm run borongan:tutup-semua -- --jalankan            → simpan (jalankan npm run backup dulu); bawaan --tanpa-upah
 *   npm run borongan:tutup-semua -- --jalankan --klaim-sisa → sekalian ajukan klaim upah setoran yang belum diklaim
 *                                                           (lewat mekanisme klaim yang ada; tidak dobel; tetap perlu persetujuan)
 * TIDAK membuat mutasi stok (sisa di titik dianggap sudah tercermin di laporan shift), TIDAK membuat/menghapus upah,
 * klaim (kecuali --klaim-sisa), atau jurnal. Setiap kiriman yang ditutup dicatat di audit.
 */
import { prisma } from "../src/lib/db";
import { applyCloseAll, closeLines, planCloseAll } from "../src/lib/boronganTutup";
import { todayStr } from "../src/lib/time";

const run = process.argv.includes("--jalankan");
const klaimSisa = process.argv.includes("--klaim-sisa") && !process.argv.includes("--tanpa-upah");
const actor = { id: "script", name: "Skrip tutup borongan (cut-over)" };

async function main() {
  console.log(`${run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)"} · upah: ${klaimSisa ? "--klaim-sisa (ajukan klaim setoran yang belum diklaim)" : "--tanpa-upah (upah/klaim tidak diubah)"}`);
  const plan = await planCloseAll();
  for (const l of closeLines(plan)) console.log(l);
  if (!run) {
    console.log("\nBelum ada yang diubah. Bila sesuai: npm run backup, lalu npm run borongan:tutup-semua -- --jalankan");
    return;
  }
  const r = await prisma.$transaction((tx) => applyCloseAll(tx, plan, actor, { note: `Tutup administratif cut-over stok laporan shift ${todayStr()}`, klaimSisa }), { timeout: 120000 });
  console.log(`\n${r.closed} kiriman ditandai SELESAI.${r.claims.length ? `\nKlaim upah diajukan (menunggu persetujuan): ${r.claims.join("; ")}` : ""}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
