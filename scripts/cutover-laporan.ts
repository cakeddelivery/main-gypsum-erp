/**
 * Cut-over stok dari laporan shift TERKIRIM satu tanggal: stok riil semua barang (bahan baku, setengah jadi, produk jadi)
 * per lokasi gudang = stok akhir laporan shift tanggal itu (shift terakhir bila beberapa; tiap divisi ikut laporannya).
 *
 *   npm run stok:cutover-laporan -- --tanggal 2026-11-20                → pratinjau (tidak mengubah apa pun)
 *   npm run stok:cutover-laporan -- --tanggal 2026-11-20 --jalankan     → simpan (jalankan npm run backup dulu)
 * Opsi:
 *   --paksa               jalankan walau ada laporan wajib yang belum terkirim
 *   --mulai-tanggal-sama  tanggal mulai stok terpadu = tanggal cut-over (bawaan: hari berikutnya, agar kirim ulang laporan
 *                         tanggal cut-over tidak memposting hasil kerjanya lagi di atas saldo cut-over)
 *   --akun-selisih        selisih nilai ke Beban Selisih Persediaan (bawaan: Ekuitas Saldo Awal, sama dengan Stok awal riil)
 * Barang yang tidak dihitung di laporan mana pun TIDAK diubah. Penyesuaian bertanda ref CUTOVER-<tanggal>; riwayat tidak dihapus.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { applyReportCutover, cutoverLines, planReportCutover, startAfterCutover } from "../src/lib/cutoverLaporan";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const tanggal = argv.find((a) => a.startsWith("--tanggal="))?.split("=")[1] ?? argv[argv.indexOf("--tanggal") + 1];
const run = flag("--jalankan");
const actor = { id: "script", name: "Skrip cut-over laporan shift" };
class Rollback extends Error {}

async function main() {
  if (!tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || !argv.some((a) => a.startsWith("--tanggal"))) throw new Error("Pakai: npm run stok:cutover-laporan -- --tanggal YYYY-MM-DD [--jalankan]");
  console.log(run ? "MODE SIMPAN" : "PRATINJAU (tambahkan --jalankan untuk menyimpan)");
  try {
    await prisma.$transaction(async (tx) => {
      const plan = await planReportCutover(tx, tanggal);
      for (const l of cutoverLines(plan)) console.log(l);
      const start = startAfterCutover(tanggal, flag("--mulai-tanggal-sama"));
      console.log(`\nTanggal mulai stok terpadu → ${start}${start === tanggal ? "" : " (hari berikutnya; laporan sesudahnya diposting normal dari saldo baru)"}. Selisih nilai → ${flag("--akun-selisih") ? "Beban Selisih Persediaan" : "Ekuitas Saldo Awal"}.`);
      if (!run) throw new Rollback();
      if (plan.unsent.length && !flag("--paksa")) throw new Error(`Ditolak: ${plan.unsent.length} laporan wajib belum terkirim. Minta divisi mengirim dulu, atau ulangi dengan --paksa.`);
      const r = await applyReportCutover(tx, plan, actor, { sameDay: flag("--mulai-tanggal-sama"), account: flag("--akun-selisih") ? "selisih" : "ekuitas" });
      console.log(`\nTersimpan: ${r.moved} penyesuaian (ref ${plan.ref}); tanggal mulai stok terpadu ${r.start}.`);
    }, { timeout: 300000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e) {
    if (e instanceof Rollback) console.log(`\nBelum ada yang diubah. Bila sesuai: npm run backup, lalu npm run stok:cutover-laporan -- --tanggal ${tanggal} --jalankan`);
    else throw e;
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
