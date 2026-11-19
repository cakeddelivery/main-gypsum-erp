/*
 * Laporan shift yang shift-nya tidak cocok dengan absen PIC pengirimnya (mis. Rico absen Shift 1 tetapi laporan Shift 2).
 *   npm run perbaiki:shift-laporan                 -> PRATINJAU (tidak menyimpan apa pun)
 *   npm run perbaiki:shift-laporan -- --jalankan   -> memindahkan yang tidak bentrok (jalankan npm run backup dulu)
 * Yang BENTROK (shift tujuan sudah punya laporan) hanya dilaporkan; pindahkan/tukar manual lewat tombol "Pindahkan ke shift lain" di detail laporan.
 */
import { prisma } from "../src/lib/db";
import { applyReportShiftFixes, findReportShiftMismatches } from "../src/lib/reportShift";

const apply = process.argv.includes("--jalankan");
(async () => {
  const fixes = await findReportShiftMismatches(60);
  console.log(`${apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)"}: ${fixes.length} laporan shift tidak cocok dengan absen PIC`);
  for (const f of fixes) console.log("  " + f.label);
  if (apply && fixes.length) console.log(`  ${await applyReportShiftFixes(fixes)} laporan dipindah`);
  if (!apply && fixes.length) console.log("\nBila sudah sesuai, jalankan: npm run perbaiki:shift-laporan -- --jalankan");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
