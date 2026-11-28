/*
 * Reklas pembelian LPG oven yang sudah terposting ke beban lain (mis. 6-1300 Beban Listrik, Air & Gas) ke 6-1310 Beban LPG Produksi (BOP).
 * Jurnal reklas Dr 6-1310 / Cr akun lama per transaksi (bertanggal transaksi); transaksi TIDAK diubah/dihapus. Idempoten.
 *   npm run koreksi:lpg-reklas                 -> pratinjau
 *   npm run koreksi:lpg-reklas -- --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 *   --harga-tabung=20000   (opsional, eksplisit) baris LPG tanpa nominal tetapi menyebut "N tabung" dihitung N × harga ini; tanpa opsi tetap "perlu cek manual"
 */
import { PrismaClient } from "@prisma/client";
import { lpgReklas } from "../src/lib/lpgReklas";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const hargaArg = process.argv.find((a) => a.startsWith("--harga-tabung="))?.slice("--harga-tabung=".length);
const hargaTabung = hargaArg ? Number(hargaArg) : undefined;
if (hargaArg && !(hargaTabung && hargaTabung > 0)) throw new Error("--harga-tabung harus angka rupiah > 0, mis. --harga-tabung=20000");
const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
lpgReklas(prisma, apply, { hargaTabung })
  .then(({ rows, manual, journals, gagal, akunAda }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    if (hargaTabung) console.log(`Harga per tabung (opsi eksplisit): ${rp(hargaTabung)} — dipakai untuk baris LPG tanpa nominal yang menyebut jumlah tabung`);
    if (!akunAda) console.log("Akun 6-1310 belum ada (jalankan migrasi terbaru). Tidak ada yang dikoreksi.");
    for (const r of rows) console.log(`  ${r.number} (${r.date.toISOString().slice(0, 10)}): ${rp(r.amount)} dari ${r.akun} ${r.akunNama} → 6-1310 · ${r.teks.slice(0, 70)}`);
    console.log(`\n${rows.length} transaksi${apply ? `, ${journals} jurnal dibuat` : " akan direklas"}; total ${rp(rows.reduce((a, r) => a + r.amount, 0))}.`);
    for (const m of manual) console.log(`⚠ PERLU CEK MANUAL ${m.number}: ${m.alasan} · ${m.teks.slice(0, 70)}`);
    for (const g of gagal) console.log(`⚠ ${g}`);
    if (!apply && rows.length) console.log("\nBila sudah sesuai (setelah npm run backup): tambahkan --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
