/*
 * Perbaiki absen shift malam yang tercatat sebagai "Absen Masuk" hari baru setelah tengah malam (sebelum hotfix
 * tanggal kerja). Absen itu dipindah menjadi absen PULANG tanggal kerja kemarin; baris hari baru dihapus.
 * Hanya baris yang memenuhi semua syarat (lihat src/lib/nightShiftFix.ts). Setiap perubahan dicatat di audit log.
 *   npm run perbaiki:shift-malam                 -> pratinjau (tidak menyimpan apa pun)
 *   npm run perbaiki:shift-malam -- --jalankan   -> menyimpan (jalankan npm run backup dulu)
 */
import { prisma } from "../src/lib/db";
import { applyNightFixes, applyNightReportFixes, findNightFixes, findNightReportFixes } from "../src/lib/nightShiftFix";

const apply = process.argv.includes("--jalankan");
(async () => {
  const fixes = await findNightFixes(14);
  console.log(`${apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)"}: ${fixes.length} absen shift malam perlu diperbaiki`);
  for (const f of fixes) console.log("  " + f.line);
  if (apply && fixes.length) await applyNightFixes(fixes);
  // Laporan shift malam yang tercatat di tanggal hari baru → tanggal mulai shift
  const reports = await findNightReportFixes(14);
  console.log(`\n${reports.length} laporan shift malam perlu dipindah ke tanggal mulai shift`);
  for (const r of reports) console.log("  " + r.label);
  if (apply && reports.length) console.log(`  ${await applyNightReportFixes(reports)} laporan dipindah`);
  if (!apply && (fixes.length || reports.length)) console.log("\nBila sudah sesuai, jalankan: npm run perbaiki:shift-malam -- --jalankan");
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
