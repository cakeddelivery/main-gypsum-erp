/*
 * Overhead aktual vs yang dibebankan ke persediaan per bulan (HANYA MEMBACA):
 *   npm run cek:overhead-bulanan
 * Aktual = beban overhead bulan itu (LPG: isi ulang dibayar + estimasi; lainnya: nilai bulanan master Overhead / penyusutan).
 * Dibebankan = kredit akun 6-1850 Overhead Pabrik Dibebankan (full costing). Selisih > 0 = under-applied, < 0 = over-applied;
 * selisih TIDAK dikoreksi: tetap menjadi beban periode (beban aslinya sudah dicatat di akunnya masing-masing).
 */
import { prisma } from "../src/lib/db";
import { overheadBulanan } from "../src/lib/overheadFullCost";

const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
(async () => {
  const list = await overheadBulanan(prisma);
  console.log("OVERHEAD AKTUAL vs DIBEBANKAN KE PERSEDIAAN (6-1850)\n");
  for (const m of list) {
    console.log(`${m.bulan}: aktual ${rp(m.aktual)} · dibebankan ${rp(m.dibebankan)} · selisih ${rp(m.selisih)} (${m.selisih > 0 ? "under-applied" : m.selisih < 0 ? "over-applied" : "pas"})`);
    for (const r of m.rows) console.log(`   ${r.category}: ${r.nama} · aktual ${rp(r.aktual)} · dibebankan ${rp(r.dibebankan)} · selisih ${rp(r.selisih)}`);
  }
  if (!list.some((m) => m.rows.length)) console.log("Belum ada overhead di resep barang (setengah jadi / jadi).");
  console.log("\nSelisih tetap jadi beban periode (tidak dikoreksi).");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
