/*
 * Batalkan transaksi Keuangan yang SUDAH diputuskan owner sebagai dobel (setelah melihat scripts/diagnosa-keuangan-dobel.ts).
 * Tidak menghapus apa pun: memakai pembatalan resmi (jurnal pembalik, saldo rekening & laporan kembali seperti sebelum transaksi).
 *
 *   npx tsx scripts/batalkan-transaksi-dobel.ts --nomor=TRX-202611-0134,TRX-202611-0187            -> PRATINJAU saja
 *   npm run backup && npx tsx scripts/batalkan-transaksi-dobel.ts --nomor=TRX-202611-0134 --jalankan  -> membatalkan
 *
 * Pengaman: tiap nomor harus Dibukukan/Dalam Proses, dan masih punya KEMBARAN aktif (rekening, nominal, arah sama, <3 menit)
 * yang TIDAK ikut dibatalkan; menolak bila semua kembaran akan dibatalkan sekaligus. Transaksi dari menu lain (gaji, pembelian, dst.)
 * ditolak: batalkan di menu asalnya. Aman diulang (yang sudah dibatalkan dilewati).
 */
import { PrismaClient } from "@prisma/client";
import { cancelBookedTransaction } from "../src/lib/finance";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const nomor = (process.argv.find((a) => a.startsWith("--nomor="))?.slice(8) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const idr = (n: unknown) => "Rp" + Number(n).toLocaleString("id-ID");

async function main() {
  if (!nomor.length) throw new Error("Wajib isi --nomor=TRX-...,TRX-... (lihat hasil diagnosa-keuangan-dobel.ts)");
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip batalkan-dobel" };
  console.log(`Mode: ${apply ? "JALANKAN" : "pratinjau (tambahkan --jalankan untuk membatalkan; jalankan npm run backup lebih dulu)"}\n`);
  const cancelling = new Set(nomor);
  let ok = 0;
  for (const n of nomor) {
    const t = await prisma.financeTransaction.findUnique({ where: { number: n } });
    if (!t) { console.log(`  ✗ ${n}: tidak ditemukan`); continue; }
    if (t.status === "DIBATALKAN") { console.log(`  = ${n}: sudah dibatalkan`); continue; }
    if (t.origin) { console.log(`  ✗ ${n}: berasal dari menu lain (${t.origin}); batalkan di menu asalnya`); continue; }
    if (t.status !== "DIBUKUKAN" && t.status !== "DALAM_PROSES") { console.log(`  ✗ ${n}: status ${t.status}, hanya Dibukukan/Dalam Proses yang dibatalkan`); continue; }
    const twins = await prisma.financeTransaction.findMany({
      where: { id: { not: t.id }, direction: t.direction, accountId: t.accountId, toAccountId: t.toAccountId, amount: t.amount, status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, deletedAt: null, date: { gte: new Date(t.date.getTime() - 180_000), lte: new Date(t.date.getTime() + 180_000) } },
      select: { number: true },
    });
    const survivors = twins.filter((x) => !cancelling.has(x.number));
    if (!survivors.length) { console.log(`  ✗ ${n}: tidak ada kembaran aktif yang tersisa (${twins.map((x) => x.number).join(", ") || "tidak ada kembaran"}); menolak agar tidak membatalkan semuanya`); continue; }
    console.log(`  ${apply ? "→" : "+"} ${n} ${idr(t.amount)} (${t.status}) dibatalkan; kembaran yang dipertahankan: ${survivors.map((x) => x.number).join(", ")}`);
    if (apply) {
      const r = await cancelBookedTransaction(t.id, actor, "Dobel (hasil audit & diagnosa keuangan, keputusan owner)");
      console.log(`      jurnal pembalik ${r.reversal.number}`);
    }
    ok++;
  }
  console.log(`\n${ok} transaksi ${apply ? "dibatalkan" : "akan dibatalkan"}.`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
