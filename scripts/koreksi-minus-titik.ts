/*
 * KOREKSI stok MINUS di lokasi titik borongan / driver (menolkan saldo minus), pola sama dengan opname titik (OPT):
 *   npm run koreksi:minus-titik                       -> PREVIEW (tidak mengubah data)
 *   npm run backup && npm run koreksi:minus-titik -- --jalankan
 * Satu mutasi PENYESUAIAN naik per barang × lokasi (ref OPT:<kode titik>, OPT:DRV untuk driver); jurnal mengikuti perlakuan opname titik
 * yang sudah ada (selisih persediaan). Satu transaksi Serializable; setelahnya tidak boleh ada saldo minus di titik/driver, bila ada → dibatalkan.
 * Saldo plus & gudang utama tidak disentuh (gudang utama: koreksi-stok-minus.ts).
 */
import { prisma } from "../src/lib/db";
import { applyMinusTitik, planMinusTitik } from "../src/lib/koreksiMinusTitik";

const run = process.argv.includes("--jalankan");
const n = (x: number) => x.toLocaleString("id-ID");

async function main() {
  const rows = await planMinusTitik();
  console.log(`${run ? "EKSEKUSI" : "PREVIEW (tidak mengubah data)"} · saldo minus di titik borongan / driver: ${rows.length}\n`);
  for (const r of rows) console.log(`  ${r.sku.padEnd(12)} ${r.name.slice(0, 32).padEnd(32)} @ ${r.lokasi.padEnd(22)} ${n(r.qty).padStart(10)} → 0  (+${n(-r.qty)}) ≈ Rp ${n(r.value)} · ref OPT:${r.refCode}`);
  if (!rows.length) return console.log("Tidak ada saldo minus di titik/driver.");
  console.log(`\nNilai penyesuaian ≈ Rp ${n(rows.reduce((a, r) => a + r.value, 0))} (jurnal selisih persediaan mengikuti opname titik).`);
  if (!run) return console.log("\nPreview saja. Jalankan: npm run backup && npm run koreksi:minus-titik -- --jalankan");
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("Tidak ada pengguna Owner aktif");
  const r = await applyMinusTitik({ id: owner.id, name: `${owner.name} (koreksi minus titik)` });
  console.log(`\nSELESAI. ${r.rows.length} saldo dinolkan; tidak ada lagi saldo minus di titik/driver.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
