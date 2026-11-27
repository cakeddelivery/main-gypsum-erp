/*
 * RESET riwayat Kirim Assembling, Kirim Cat, dan penerimaan bahan/hasil tiap divisi — TANPA mengubah stok:
 *   npm run reset:kiriman                          -> PREVIEW (tidak mengubah data apa pun)
 *   npm run backup && npm run reset:kiriman -- --jalankan [--sampai=2026-11-27T02:00]
 * --sampai (WIB; tanggal saja = akhir hari itu): hanya dokumen bertanggal ≤ itu yang dihapus (bawaan: semua).
 *
 * Dihapus: kiriman borongan (KRM) + tugas/bahan/pembagian/laporan hasil/pengambilan (AMB), penerimaan divisi (BoronganReceipt),
 * barang masuk laporan shift (ShiftReceipt) yang BELUM tertaut Pembelian, setoran upah BELUM dibayar dari pengambilan itu,
 * klaim upah menunggu yang isinya habis (klaim yang masih punya isi dihitung ulang), dan mutasi stok ber-ref KRM:/BGI:/AMB:/HSB:/PND: (+ BATAL-…).
 * Tetap: jurnal (semua), setoran yang sudah dibayar (hanya dilepas dari pengambilan), ShiftReceipt yang tertaut Pembelian (dilewati & dilaporkan).
 * Stok: saldo tiap barang × lokasi disimpan sebelum menghapus, lalu 1 mutasi PENYESUAIAN per barang × lokasi (ref SALDO-AWAL-2026-11-27, tanpa jurnal)
 * mengembalikannya persis; bila ada yang beda, seluruh transaksi dibatalkan. Satu transaksi Serializable. Satu entri audit ringkasan.
 */
import { prisma } from "../src/lib/db";
import { MALAM_BATAS, collectReset, runReset } from "../src/lib/resetKiriman";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const run = process.argv.includes("--jalankan");
const n = (x: number) => x.toLocaleString("id-ID");

function parseSampai(v: string | undefined): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T23:59:59+07:00`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return new Date(`${v}:00+07:00`);
  throw new Error("--sampai harus YYYY-MM-DD atau YYYY-MM-DDTHH:mm (WIB)");
}

async function main() {
  const sampai = parseSampai(arg("sampai"));
  const plan = await collectReset(prisma, { sampai });
  console.log(`${run ? "EKSEKUSI" : "PREVIEW (tidak mengubah data)"} · reset riwayat kiriman & penerimaan${sampai ? ` · dokumen s/d ${sampai.toISOString()}` : " · semua dokumen"}\n`);
  console.log(`Kiriman borongan        : ${n(plan.shipments.length)} (${plan.shipments.slice(0, 3).map((s) => s.number).join(", ")}${plan.shipments.length > 3 ? ", …" : ""})`);
  console.log(`Pengambilan (AMB)        : ${n(plan.pickups.length)}`);
  console.log(`Setoran upah dihapus     : ${n(plan.resultsDelete)} (belum dibayar)`);
  console.log(`Setoran dilepas dari AMB : ${n(plan.resultsDetach)} (sudah dibayar/settlement: TETAP, jurnal tetap)`);
  console.log(`Klaim upah               : ${n(plan.claimsDelete)} dihapus (isi habis) · ${n(plan.claimsUpdate)} dihitung ulang`);
  console.log(`Penerimaan divisi        : ${n(plan.receipts.length)}`);
  console.log(`Barang masuk laporan     : ${n(plan.shiftReceipts)} dihapus · ${n(plan.shiftReceiptsSkipped.length)} DILEWATI (tertaut Pembelian)`);
  for (const s of plan.shiftReceiptsSkipped.slice(0, 10)) console.log(`      - ${s.number} → pembelian ${s.purchaseId}`);
  console.log(`Mutasi stok dihapus      : ${n(plan.movements)} ${JSON.stringify(plan.movementsByPrefix)}`);
  console.log(`\nStok TIDAK berubah: saldo semua barang×lokasi dikembalikan lewat PENYESUAIAN "SALDO-AWAL-2026-11-27" (tanpa jurnal).`);
  if (plan.lateMovements || plan.lateDocs.length) {
    console.log(`\n⚠ PERHATIAN: ada data bertanggal SETELAH ${MALAM_BATAS.toISOString()} (27 Nov 02:00 WIB). Saldo akhir = stok SAAT SKRIP DIJALANKAN, bukan "stok tadi malam":`);
    console.log(`   mutasi sesudah batas: ${n(plan.lateMovements)}${plan.lateDocs.length ? ` · dokumen: ${plan.lateDocs.slice(0, 8).join(", ")}${plan.lateDocs.length > 8 ? ", …" : ""}` : ""}`);
    console.log(`   Pakai --sampai=2026-11-27T02:00 bila hanya dokumen s/d jam itu yang dihapus.`);
  }
  if (!run) return console.log("\nPreview saja. Jalankan: npm run backup && npm run reset:kiriman -- --jalankan");
  const r = await runReset({ sampai }, { id: "system", name: "reset-kiriman-penerimaan" });
  console.log(`\nSELESAI. ${n(r.adjustments)} penyesuaian saldo dibuat (dari ${n(r.snapshotRows)} barang×lokasi); saldo sesudah == snapshot untuk SEMUA barang×lokasi.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
