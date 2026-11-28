/*
 * Koreksi selisih persediaan lewat JURNAL PENYESUAIAN (tidak menghapus / mengubah transaksi terposting) agar buku besar = nilai stok.
 *   npm run koreksi:rekonsiliasi-persediaan                       -> pratinjau (daftar baris + kelompok yang masih perlu keputusan owner)
 *   npm run koreksi:rekonsiliasi-persediaan -- <keputusan> --jalankan   -> menyimpan (jalankan `npm run backup` dulu)
 * Keputusan (tiap kelompok hanya dikoreksi bila diputuskan):
 *   --finance-tanpa-stok=beban-pemakaian | selisih      transaksi Finance debit persediaan tanpa stok masuk: reklas ke Beban Pemakaian Bahan Baku
 *                                                       atau Beban Selisih Persediaan. (Pilihan lain: buat penerimaan stok lewat Barang masuk/Pembelian, tanpa skrip ini.)
 *   --penerimaan-tanpa-jurnal=saldo-awal | selisih      lawan: Ekuitas Saldo Awal atau Beban Selisih Persediaan
 *   --sisa=selisih                                      sisa yang belum terjelaskan → Beban Selisih Persediaan (6-1800)
 *   --sisa=reklas-antar-persediaan                      hanya bagian TERBUKTI (jenis referensi yang sama: 1-1401 terlalu tinggi & 1-1403 terlalu rendah, lihat
 *                                                       diagnosis di npm run cek:rekonsiliasi-persediaan): Cr 1-1401 / Dr 1-1403. Boleh digabung: --sisa=reklas-antar-persediaan,selisih
 * Idempoten: baris yang sudah dikoreksi tidak dikoreksi lagi.
 */
import { PrismaClient } from "@prisma/client";
import { koreksiRekonPersediaan, type Keputusan } from "../src/lib/rekonPersediaan";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const apply = argv.includes("--jalankan");
const ft = opt("finance-tanpa-stok");
const pj = opt("penerimaan-tanpa-jurnal");
const sisaOpt = (opt("sisa") ?? "").split(",").filter(Boolean);
if (ft && !["beban-pemakaian", "selisih"].includes(ft)) throw new Error("--finance-tanpa-stok: beban-pemakaian | selisih");
if (pj && !["saldo-awal", "selisih"].includes(pj)) throw new Error("--penerimaan-tanpa-jurnal: saldo-awal | selisih");
if (sisaOpt.some((x) => !["selisih", "reklas-antar-persediaan"].includes(x))) throw new Error("--sisa: selisih | reklas-antar-persediaan (boleh dua-duanya, dipisah koma)");
const k: Keputusan = { financeTanpaStok: ft as Keputusan["financeTanpaStok"], penerimaanTanpaJurnal: pj as Keputusan["penerimaanTanpaJurnal"], sisa: sisaOpt.includes("selisih") ? "selisih" : undefined, sisaAntar: sisaOpt.includes("reklas-antar-persediaan") ? "reklas-antar-persediaan" : undefined };
const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
koreksiRekonPersediaan(prisma, apply, k)
  .then(({ plan, journalId }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    console.log(`Akun beban LPG: ${plan.result.lpgAccount ? `${plan.result.lpgAccount.code} ${plan.result.lpgAccount.name} (baris pembelian LPG otomatis direklas ke sini, tanpa flag)` : "BELUM ADA — baris LPG diperlakukan seperti baris lain"}`);
    for (const l of plan.lines) console.log(`  ${l.kelompok} ${l.ref}: ${l.amount > 0 ? "Cr" : "Dr"} ${l.account} ${rp(Math.abs(l.amount))} / ${l.amount > 0 ? "Dr" : "Cr"} ${l.counter}${l.kelompok === "SISA_ANTAR" ? " (reklas antar-persediaan)" : ""}`);
    console.log(`\n${plan.lines.length} baris dikoreksi${journalId ? ` · jurnal ${journalId}` : ""}.`);
    for (const g of plan.belumDiputuskan) console.log(`⚠ ${g}: ${plan.result.rows.filter((r) => r.kelompok === g).length} baris BELUM diputuskan (${g === "FINANCE_TANPA_STOK" ? "--finance-tanpa-stok=beban-pemakaian|selisih, atau buat penerimaan stok" : "--penerimaan-tanpa-jurnal=saldo-awal|selisih"}) — tidak dikoreksi`);
    for (const a of plan.result.accounts) console.log(`  ${a.code}: selisih ${rp(a.diff)}, terjelaskan ${rp(a.terjelaskan)}, sisa ${rp(a.sisa)}${!k.sisa && Math.abs(a.sisa) > 1000 ? " (tambahkan --sisa=selisih untuk menyamakan)" : ""}`);
    if (!apply && plan.lines.length) console.log("\nBila sudah sesuai (setelah npm run backup): tambahkan --jalankan");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
