/*
 * Utang supplier yang dicatat Dr persediaan tanpa stok masuk (kemungkinan saldo utang awal yang barangnya sudah ada di stok awal CUTOVER).
 * PRATINJAU secara bawaan; tidak ada yang berubah tanpa opsi koreksi DAN --jalankan (jalankan `npm run backup` dulu). HANYA setelah user mengonfirmasi data utangnya.
 *   npm run koreksi:utang-awal                                   -> rincian utang, angsuran bertaut UTG, utang tanpa catatan
 *   npm run koreksi:utang-awal -- --utang-awal=ekuitas           -> pratinjau: per jurnal utang Dr 3-9000 Saldo Awal Ekuitas / Cr persediaan
 *   npm run koreksi:utang-awal -- --angsuran=ya                  -> pratinjau: pembayaran Finance ke supplier ber-UTG yang mendebit persediaan: bertanggal SEBELUM UTG → Dr 3-9000 Ekuitas Saldo Awal / Cr persediaan (UTG tidak dikurangi); pada/sesudah tanggal UTG → Dr 2-1100 / Cr persediaan + tandai terbayar di UTG
 *   ... --jalankan                                               -> menyimpan
 * Finance serupa TANPA UTG ("utang tanpa catatan") hanya ditampilkan.
 */
import { PrismaClient } from "@prisma/client";
import { koreksiUtangAwal, type UtangAwalOpsi } from "../src/lib/utangAwal";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const apply = argv.includes("--jalankan");
const ua = opt("utang-awal");
const ang = opt("angsuran");
if (ua && ua !== "ekuitas") throw new Error("--utang-awal: ekuitas");
if (ang && ang !== "ya") throw new Error("--angsuran: ya");
const o: UtangAwalOpsi = { utangAwal: ua as UtangAwalOpsi["utangAwal"], angsuran: ang as UtangAwalOpsi["angsuran"] };
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
koreksiUtangAwal(prisma, apply, o)
  .then(({ plan, lines, journals }) => {
    console.log(apply ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    console.log(`\nUTANG Dr persediaan (${plan.utang.length}), total ${rp(plan.totalUtang)}:`);
    for (const u of plan.utang) console.log(`   ${u.number} ${u.journalNumber} (${day(u.date)}) ${u.supplier ?? u.vendor}: ${rp(u.nominalPersediaan)} di ${u.akun} · utang ${rp(u.amount)} terbayar ${rp(u.paid)}${u.sudahDikoreksi ? " · SUDAH dikoreksi" : ""}`);
    console.log(`\nANGSURAN Finance ke supplier ber-UTG yang mendebit persediaan (${plan.angsuran.length}):`);
    for (const a of plan.angsuran) console.log(`   ${a.txNumber} (${day(a.date)}) ${rp(a.nominal)} di ${a.akun} → ${a.utg}${a.sebelumUtg ? " · SEBELUM UTG → Dr Ekuitas Saldo Awal (UTG tidak dikurangi)" : " · sesudah UTG → Dr 2-1100, bayar UTG"}${a.sudahDikoreksi ? " · SUDAH dikoreksi" : ""} · ${a.teks.slice(0, 60)}`);
    console.log(`\nUTANG TANPA CATATAN (tanpa UTG; menunggu data dari user, tidak dikoreksi) (${plan.tanpaCatatan.length}):`);
    for (const t of plan.tanpaCatatan) console.log(`   ${t.txNumber} (${day(t.date)}) ${rp(t.nominal)} · ${t.teks.slice(0, 60)}`);
    console.log(`\nBaris koreksi terpilih: ${lines.length}${apply ? `, ${journals} jurnal dibuat` : ""}`);
    for (const l of lines) console.log(`   Dr ${l.akunDr} / Cr ${l.akunCr} ${rp(l.amount)} · ${l.keterangan.slice(0, 80)}`);
    if (!ua && !ang) console.log("\nTambahkan --utang-awal=ekuitas dan/atau --angsuran=ya (pratinjau), lalu --jalankan setelah user mengonfirmasi.");
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
