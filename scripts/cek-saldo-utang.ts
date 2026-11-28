/*
 * Saldo utang per pihak vs data konfirmasi user (HANYA MEMBACA). File CSV dibuat user di server, DI LUAR repo:
 *   pihak,jenis,sisa,tanggal        (jenis = supplier | modal; alias pihak dipisah "|", mis. "Nama Utama|Nama Lain")
 *   npm run cek:saldo-utang -- --file=~/utang-28nov.csv
 * Per pihak: saldo sistem (UTG supplier / pinjaman modal), pembayaran Finance yang cocok nama (sebelum/sesudah tanggal UTG, bertaut/tidak, akun debit),
 * saldo sistem setelah koreksi utang-awal, target, selisih, dan usulan.
 */
import fs from "node:fs";
import os from "node:os";
import { prisma } from "../src/lib/db";
import { analisaSaldoUtang, parseUtangCsv } from "../src/lib/saldoUtang";

const arg = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
if (!arg) throw new Error("Pakai --file=~/utang-28nov.csv (format: pihak,jenis,sisa,tanggal)");
const file = arg.replace(/^~/, os.homedir());
const rp = (n: number) => `${n < 0 ? "-" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
(async () => {
  const rows = parseUtangCsv(fs.readFileSync(file, "utf8"));
  const hasil = await analisaSaldoUtang(prisma, rows);
  for (const a of hasil) {
    console.log(`\n=== ${a.row.pihak} (${a.row.jenis}) · target ${rp(a.row.sisa)} per ${a.row.tanggal || "-"} ===`);
    const own = a.row.jenis === "supplier" ? a.utg : a.modal;
    for (const u of own) console.log(`   ${u.number} (${day(u.date)}) ${u.vendor}: utang ${rp(u.amount)} terbayar ${rp(u.paid)} sisa ${rp(u.sisa)}`);
    if (!own.length) console.log("   (tidak ada UTG / pinjaman di sistem)");
    for (const p of a.pembayaran) console.log(`   bayar ${p.txNumber} (${day(p.date)}) ${rp(p.nominal)} ${p.sebelumUtg ? "SEBELUM UTG" : "pada/sesudah UTG"} ${p.bertaut ? `bertaut ${p.bertaut}` : "tidak bertaut"} · debit ${p.debit.map((d) => `${d.akun} ${rp(d.nominal)}`).join(", ") || "-"} · ${p.teks.slice(0, 50)}`);
    for (const t of a.transaksiModal) console.log(`   finance ${t.txNumber} (${day(t.date)}) ${t.arah} ${rp(t.nominal)} · ${t.teks.slice(0, 60)}`);
    console.log(`   saldo sistem ${rp(a.saldoSistem)} · efek koreksi utang-awal ${rp(-a.efekKoreksiAwal)} → setelah koreksi ${rp(a.saldoSetelahKoreksi)} · selisih vs target ${rp(a.selisih)}`);
    for (const u of a.usulan) console.log(`   usul [${u.jenis}] ${rp(u.amount)}: ${u.keterangan}`);
    if (!a.usulan.length) console.log("   ✓ sesuai target");
  }
  console.log("\nKoreksi per pihak (pratinjau; --jalankan setelah npm run backup): npm run koreksi:saldo-utang -- --file=… --pihak=<nama> --utang-lama | --reklas-bayar | --saldo-awal-modal");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
