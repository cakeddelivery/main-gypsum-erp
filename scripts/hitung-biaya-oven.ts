/*
 * Biaya oven (LPG) & gypsum per patung dari data ERP (HANYA MEMBACA, kecuali dengan --pasang --jalankan):
 *   npm run hitung:biaya-oven                          -> laporan per bulan (6 bulan) + 30 hari terakhir
 *   npm run hitung:biaya-oven -- --pasang              -> pratinjau pemasangan resep
 *   npm run hitung:biaya-oven -- --pasang --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 *   --gypsum=<SKU>                                     -> pilih barang gypsum bila ada beberapa
 *   --gram-per-unit=<N>                                -> bila satuan resep gypsum bukan gram/kg (mis. sak = 18000 gram): koreksi/pasang 30 g = 30÷N satuan
 *   --aset=<regex>                                     -> pilih aset tetap alat produksi/cetakan (bawaan: cetakan|alat|mesin|produksi, tanpa oven)
 * Patung cetak = 30 g gypsum; patung kering = 1 patung cetak + biaya oven per pcs (overhead LPG di resep, tanpa model baru).
 * Biaya LPG per pcs = biaya LPG (isi ulang tabung dari laporan Oven yang dipasangkan ke transaksi Finance) ÷ panen patung kering laporan Oven.
 */
import { PrismaClient } from "@prisma/client";
import { GYPSUM_GRAM_PER_PCS, biayaGypsum, biayaLpgPerPeriode, overheadTerkait, pasangBiayaOven, penyusutanAset } from "../src/lib/biayaOven";

const prisma = new PrismaClient();
const argv = process.argv;
const rp = (n: number | null, d = 0) => (n == null ? "-" : `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: d })}`);

async function main() {
  const per = await biayaLpgPerPeriode(prisma);
  console.log("BIAYA OVEN (LPG) PER PCS PATUNG KERING\n");
  for (const p of per) {
    console.log(`${p.label}: LPG ${rp(p.lpg.dipakai)} ÷ panen ${p.panen.bagus.toLocaleString("id-ID")} pcs (${p.panen.laporan} laporan Oven) = ${rp(p.lpgPerPcs, 2)}/pcs`);
    console.log(`   sumber: isi ulang dibayar ${rp(p.lpg.isiUlangDibayar)} (${p.lpg.isiUlangTabungDibayar} tabung) · transaksi Finance LPG ${rp(p.lpg.financeLpg)} · estimasi isi ulang belum dipasangkan ${rp(p.lpg.estimasiMenunggu)} · pembelian barang LPG ${rp(p.lpg.pembelianItem)}`);
    for (const b of p.lpg.financeBaris) console.log(`      Finance ${b.number} (${b.date.toISOString().slice(0, 10)}): ${rp(b.amount)}${b.mode === "penuh" ? "" : ` dari ${rp(b.total)} [${b.mode === "baris" ? "baris LPG diparse" : "baris rincian LPG"}]`} · ${b.teks.slice(0, 80)}`);
    for (const c of p.lpg.catatan) console.log(`   ⚠ ${c}`);
  }
  const gy = await biayaGypsum(prisma);
  console.log(`\nGYPSUM per patung cetak (${GYPSUM_GRAM_PER_PCS} g):`);
  if (!gy.length) console.log("  tidak ada barang bahan baku bernama gypsum");
  for (const g of gy) console.log(`  ${g.sku} ${g.name}: ${rp(g.hargaStok)}/${g.unit} (${g.sumber}), 1 ${g.unit} = ${g.factor.toLocaleString("id-ID")} ${g.hppUnit} → ${g.perGram == null ? `satuan "${g.hppUnit}" bukan gram/kg` : `${rp(g.perGram, 4)}/g × ${GYPSUM_GRAM_PER_PCS} g = ${rp(g.per30g)}/pcs`}`);
  const oh = await overheadTerkait(prisma, per[per.length - 1].panen.bagus);
  const aset = argv.find((a) => a.startsWith("--aset="))?.slice(7);
  const pola = aset ? new RegExp(aset, "i") : undefined;
  const dep = await penyusutanAset(prisma, { pola });
  console.log("\nPENYUSUTAN alat produksi & cetakan (modul Aset tetap) per pcs patung cetak — ikut HPP sebagai overhead resep Patung Cetak:");
  if (!dep.aset.length) console.log("  tidak ada aset tetap aktif yang cocok (cetakan/alat/mesin/produksi; ubah dengan --aset=<regex>)");
  for (const a of dep.aset) console.log(`  ${a.nama}: ${rp(a.perBulan)}/bulan`);
  if (dep.aset.length) console.log(`  total ${rp(dep.perBulan)}/bulan ÷ ${dep.produksiCetak.toLocaleString("id-ID")} pcs (${dep.sumberProduksi}) = ${rp(dep.perPcs, 2)}/pcs  [pembanding 30 hari: ${dep.produksi30.toLocaleString("id-ID")} pcs]`);
  console.log("\nOVERHEAD terkait (overhead master/aset lain):");
  if (!oh.length) console.log("  tidak ada");
  for (const o of oh) console.log(`  [${o.sumber}] ${o.nama}: ${rp(o.perBulan)}/bulan${o.perPcs != null ? ` · ${rp(o.perPcs, 2)}/pcs` : ""}${o.catatan ? ` (${o.catatan})` : ""}`);

  if (argv.includes("--pasang")) {
    const apply = argv.includes("--jalankan");
    const gypsumSku = argv.find((a) => a.startsWith("--gypsum="))?.slice(9);
    const gpu = Number(argv.find((a) => a.startsWith("--gram-per-unit="))?.slice(16));
    const plan = await pasangBiayaOven(prisma, apply, { gypsumSku, poolAset: pola, gramPerUnit: gpu > 0 ? gpu : undefined });
    console.log(`\n${apply ? "DISIMPAN" : "PRATINJAU PASANG (belum disimpan)"}:`);
    for (const b of plan.baris) console.log(`  ${b}`);
    for (const d of plan.ditunda) console.log(`  ! ${d}`);
    if (!apply && plan.ok) console.log("\nBila sudah sesuai (setelah npm run backup): npm run hitung:biaya-oven -- --pasang --jalankan");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
