/*
 * Satukan lokasi stok per jenis barang (bahan → gudang bahan, setengah jadi → gudang setengah jadi, jadi → gudang barang jadi).
 * TRANSFER antar gudang (nilai & total tidak berubah, tanpa jurnal), ref REKON:LOKASI:<sku>. Idempoten.
 *   npm run koreksi:lokasi-stok                -> pratinjau: saldo per lokasi per barang + usulan transfer (+ asal harga rata-rata Cat Plastik)
 *   npm run koreksi:lokasi-stok -- --jalankan  -> menyimpan (jalankan `npm run backup` dulu)
 * Titik borongan / driver / stok divisi tidak disentuh. Barang yang total stoknya tetap negatif = hasil belum tercatat (bukan masalah lokasi).
 */
import { PrismaClient } from "@prisma/client";
import { koreksiLokasiStok } from "../src/lib/lokasiStok";
import { refGroup } from "../src/lib/rekonPersediaan";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
(async () => {
  const { rows, transfers } = await koreksiLokasiStok(prisma, apply);
  console.log(apply ? `DISIMPAN: ${transfers} transfer` : "PRATINJAU (belum disimpan):");
  const tipe = (t: string) => (t === "BARANG_DALAM_PROSES" ? "setengah jadi" : t === "BARANG_JADI" ? "barang jadi" : "bahan baku");
  for (const r of rows) {
    console.log(`\n${r.sku} ${r.name.slice(0, 44)} [${tipe(r.type)}] lokasi benar: ${r.canonical ?? "?"} · total ${r.total}`);
    console.log(`   saldo: ${r.saldo.map((s) => `${s.lokasi}${s.gudang ? "" : " (titik/divisi)"} ${s.qty}`).join(" · ")}`);
    for (const u of r.usulan) console.log(`   usul TRANSFER ${u.qty}: ${u.from} → ${u.to}`);
    if (r.total < 0) console.log(`   ⚠ total NEGATIF ${r.total}: hasil/penerimaan belum tercatat (bukan masalah lokasi)`);
  }
  console.log(`\n${rows.length} barang perlu perhatian, ${rows.filter((r) => r.usulan.length).length} punya usulan transfer.`);
  // Asal harga rata-rata Cat Plastik (setengah jadi): penerimaan/produksi dengan harga, per jenis referensi
  const cats = await prisma.item.findMany({ where: { name: { contains: "cat plastik", mode: "insensitive" } }, select: { id: true, sku: true, name: true, avgCost: true } });
  for (const c of cats) {
    const mv = await prisma.stockMovement.findMany({ where: { itemId: c.id, toLocationId: { not: null }, fromLocationId: null, unitCost: { gt: 0 } }, orderBy: { date: "asc" }, select: { ref: true, qty: true, unitCost: true, date: true, type: true } });
    console.log(`\nHARGA RATA-RATA ${c.sku} ${c.name}: ${rp(Number(c.avgCost))} — ${mv.length} masuk bernilai`);
    for (const m of mv.slice(-8)) console.log(`   ${m.date.toISOString().slice(0, 10)} ${m.type} ${Number(m.qty)} × ${rp(Number(m.unitCost))} (${refGroup(m.ref)}) ${m.ref ?? ""}`.slice(0, 150));
    const rev = await prisma.journal.count({ where: { source: "REVALUASI_HPP" } });
    console.log(`   jurnal revaluasi HPP di sistem: ${rev} (hitung:nilai-hpp / hpp:revaluasi menggeser harga rata-rata ke nilai resep)`);
  }
  if (!apply && rows.some((r) => r.usulan.length)) console.log("\nBila sudah sesuai (setelah npm run backup): tambahkan --jalankan");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
