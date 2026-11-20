/**
 * Tutup administratif SEMUA kiriman borongan yang belum selesai (sebelum cut-over stok dari laporan shift).
 *   npm run borongan:tutup-semua                          → pratinjau (tidak mengubah apa pun)
 *   npm run borongan:tutup-semua -- --jalankan            → simpan (jalankan npm run backup dulu)
 * TIDAK membuat mutasi stok (sisa di titik dianggap sudah tercermin di laporan shift), TIDAK membuat/menghapus upah,
 * klaim, atau jurnal. Setoran yang belum diklaim dianggap sudah beres (keputusan Owner) — hanya ditampilkan sebagai info.
 * Setiap kiriman yang ditutup dicatat di audit.
 */
import { prisma } from "../src/lib/db";
import { applyCloseAll, closeLines, planCloseAll } from "../src/lib/boronganTutup";
import { todayStr } from "../src/lib/time";

const run = process.argv.includes("--jalankan");
const actor = { id: "script", name: "Skrip tutup borongan (cut-over)" };

async function main() {
  console.log(`${run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)"} · upah/klaim tidak diubah`);
  const plan = await planCloseAll();
  for (const l of closeLines(plan)) console.log(l);
  if (!run) {
    console.log("\nBelum ada yang diubah. Bila sesuai: npm run backup, lalu npm run borongan:tutup-semua -- --jalankan");
    return;
  }
  const r = await prisma.$transaction((tx) => applyCloseAll(tx, plan, actor, { note: `Tutup administratif cut-over stok laporan shift ${todayStr()}` }), { timeout: 120000 });
  console.log(`\n${r.closed} kiriman ditandai SELESAI.`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
