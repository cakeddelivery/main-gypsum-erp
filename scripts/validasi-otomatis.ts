/*
 * Selesaikan antrean "Validasi" absensi lama dengan aturan otomatis (jadwal + absen + izin):
 * dijadwalkan masuk tanpa absen = Alpa, tidak dicentang = Libur, minggu tanpa jadwal = Alpa, ada absen = tervalidasi
 * (shift Cetak/Oven mengikuti jam absen). Tidak menghapus data; setiap perubahan dicatat di audit log.
 *   npm run validasi:otomatis                 -> pratinjau (tidak menyimpan apa pun)
 *   npm run validasi:otomatis -- --jalankan   -> menyimpan (jalankan npm run backup dulu)
 */
import { prisma } from "../src/lib/db";
import { resolveAttendanceBacklog } from "../src/lib/attendanceBacklog";

const apply = process.argv.includes("--jalankan");
resolveAttendanceBacklog(apply)
  .then((r) => {
    console.log(`${apply ? "DISIMPAN" : "PRATINJAU (belum disimpan)"}: antrean ${r.queue} baris, ${r.changes.length} perubahan`);
    for (const l of r.lines) console.log("  " + l);
    if (!apply && r.changes.length) console.log("\nBila sudah sesuai, jalankan: npm run validasi:otomatis -- --jalankan");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
