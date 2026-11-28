/*
 * Koreksi saldo utang per pihak (PRATINJAU secara bawaan; --jalankan setelah `npm run backup` dan konfirmasi user). File CSV di luar repo (lihat cek:saldo-utang).
 *   npm run koreksi:saldo-utang -- --file=~/utang-28nov.csv --pihak="Nama Utama" [--utang-lama] [--reklas-bayar] [--saldo-awal-modal] [--jalankan]
 *   --reklas-bayar     supplier: sistem > target dan ada pembayaran Finance dibukukan sebagai beban → Dr 2-1100 / Cr beban itu (+ tandai terbayar di UTG)
 *   --utang-lama       supplier: sistem < target dan utang itu utang lama → Dr 3-9000 Saldo Awal Ekuitas / Cr 2-1100 + UTG baru (bila pembelian kredit baru: catat lewat Pembelian tempo)
 *   --saldo-awal-modal modal: sistem < target → pinjaman lama (Dr 3-9000 / Cr akun pinjaman) lewat fungsi Pinjaman yang ada
 * Semua koreksi per pihak dan per jenis; idempoten (selisih dihitung ulang, sourceId dijaga).
 */
import fs from "node:fs";
import os from "node:os";
import { PrismaClient } from "@prisma/client";
import { koreksiSaldoUtang, parseUtangCsv } from "../src/lib/saldoUtang";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = opt("file")?.replace(/^~/, os.homedir());
const pihak = opt("pihak");
if (!file || !pihak) throw new Error('Pakai --file=~/utang.csv --pihak="Nama" (satu pihak per jalan)');
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
koreksiSaldoUtang(prisma, parseUtangCsv(fs.readFileSync(file, "utf8")), argv.includes("--jalankan"), { pihak, utangLama: argv.includes("--utang-lama"), reklasBayar: argv.includes("--reklas-bayar"), saldoAwalModal: argv.includes("--saldo-awal-modal") })
  .then(({ analisa: a, rencana, done }) => {
    console.log(argv.includes("--jalankan") ? "DISIMPAN:" : "PRATINJAU (belum disimpan):");
    console.log(`${a.row.pihak}: sistem setelah koreksi utang-awal ${rp(a.saldoSetelahKoreksi)}, target ${rp(a.row.sisa)}, selisih ${rp(a.selisih)}`);
    for (const u of a.usulan) console.log(`  usul [${u.jenis}] ${rp(u.amount)}: ${u.keterangan}`);
    for (const r of rencana) console.log(`  → ${r.kode}: ${rp(r.amount)} · ${r.keterangan}`);
    if (!rencana.length) console.log("  Tidak ada koreksi terpilih (tambahkan flag jenis koreksi).");
    if (done.length) console.log(`  dibuat: ${done.join(", ")}`);
  })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
