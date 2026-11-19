/*
 * Selisih stok aplikasi vs stok akhir laporan shift (HANYA MEMBACA, tidak mengubah data):
 *   npm run cek:selisih-stok            -> 14 hari terakhir
 *   npm run cek:selisih-stok -- --hari=30
 * Mencetak nilai setting laporan_shift_ke_stok, selisih per laporan/barang, dan ringkasan mutasi per jenis (termasuk borongan KRM/BGI/HSB/PND).
 */
import { prisma } from "../src/lib/db";
import { kindLabel, stockGapReport } from "../src/lib/stockGap";

const days = Number(process.argv.find((a) => a.startsWith("--hari="))?.slice(7)) || 14;
const f = (n: number) => n.toLocaleString("id-ID");
(async () => {
  const r = await stockGapReport(days);
  console.log(`Setting laporan_shift_ke_stok = ${r.setting === null ? "(belum diatur → mati)" : `"${r.setting}"`} → ${r.settingOn ? "MENYALA: hasil kerja laporan shift diposting ke stok" : "MATI: hasil kerja laporan shift TIDAK diposting ke stok; selisih di bawah wajar"}`);
  console.log(`Periode ${r.from} s/d hari ini · ${r.reportsChecked} laporan terkirim diperiksa\n`);
  console.log("== Stok akhir laporan vs stok aplikasi (jam selesai shift) ==");
  const diff = r.rows.filter((x) => x.diff !== 0);
  console.log(`${r.rows.length} barang dihitung, ${diff.length} selisih`);
  for (const x of r.rows) console.log(`  ${x.date} ${x.division} ${x.shift} · ${x.name}: laporan ${f(x.counted)} | aplikasi ${f(x.system)} | selisih ${x.diff > 0 ? "+" : ""}${f(x.diff)}${x.big ? "  ‼ BESAR" : ""}`);
  console.log("\n== Mutasi setengah jadi / jadi per jenis (masuk / keluar gudang setengah jadi & jadi) ==");
  let last = "";
  for (const x of r.flows) {
    const head = `${x.division ?? "(tanpa divisi)"} · ${x.item}`;
    if (head !== last) console.log(`  ${head}`);
    last = head;
    console.log(`      ${kindLabel(x.kind)}: ${x.count}× · masuk ${f(x.masukWip)} · keluar ${f(x.keluarWip)}`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
