/*
 * Koreksi saldo rekening hasil audit 5 Nov 2026 (sekali jalan, aman diulang: tidak membukukan dua kali).
 *
 *   npx tsx scripts/koreksi-saldo-nov.ts              -> PRATINJAU saja (tidak menyimpan)
 *   npx tsx scripts/koreksi-saldo-nov.ts --jalankan   -> menyimpan 1 jurnal koreksi
 *
 * Isi jurnal (tanggal 1 Nov 2026):
 *   Dr Seabank 0006 3.000.000  - pembayaran Mas Rizal September memotong rekening, padahal saldo awal 1 Nov sudah memperhitungkannya
 *   Dr ShopeePay      200.000  - "Atur saldo" 4 Nov menetralkan sisihan kompensasi 3 Nov
 *   Cr Seabank 5984   240.000  - "Atur saldo" 4 Nov menetralkan LPG 40rb + sisihan 200rb tanggal 3 Nov
 *   Cr Ekuitas Saldo Awal 2.960.000
 *
 * WAJIB backup dulu: npm run backup
 */
import { PrismaClient } from "@prisma/client";
import { assertPeriodOpen, COA, postJournal } from "../src/lib/accounting";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const SOURCE_ID = "AUDIT-SALDO-2026-11-05";
const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");

async function balance(coaAccountId: string) {
  const s = await prisma.journalLine.aggregate({ where: { accountId: coaAccountId }, _sum: { debit: true, credit: true } });
  return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
}

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);

  const done = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: SOURCE_ID } });
  if (done) {
    console.log(`Koreksi sudah pernah dibukukan (${done.number}). Tidak ada yang diubah.`);
    return;
  }
  const bank = async (code: string) => {
    const b = await prisma.bankAccount.findUnique({ where: { code } });
    if (!b) throw new Error(`Rekening dengan kode ${code} tidak ditemukan`);
    return b;
  };
  const s5984 = await bank("SEABANK");
  const s0006 = await bank("SEABANK0006");
  const spay = await bank("SHOPEEPAY");

  // Pastikan kondisinya masih sama dengan saat audit
  const pre0006 = await prisma.journalLine.aggregate({ where: { accountId: s0006.coaAccountId, journal: { date: { lt: new Date("2026-11-01T00:00:00+07:00") } } }, _sum: { debit: true, credit: true } });
  const pre = Number(pre0006._sum.debit ?? 0) - Number(pre0006._sum.credit ?? 0);
  if (pre !== -3_000_000) throw new Error(`Saldo Seabank 0006 sebelum 1 Nov ${idr(pre)}, bukan -Rp3.000.000 seperti saat audit. Hentikan, kabari Claude.`);
  const adj = await prisma.journal.findUnique({ where: { number: "JU-202611-0005" }, include: { lines: true } });
  const amt = (id: string) => adj?.lines.filter((l) => l.accountId === id).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
  if (!adj || adj.source !== "SALDO_AWAL" || amt(s5984.coaAccountId) !== 240_000 || amt(spay.coaAccountId) !== -200_000) {
    throw new Error("Jurnal penyesuaian JU-202611-0005 tidak sesuai hasil audit. Hentikan, kabari Claude.");
  }

  const date = new Date("2026-11-01T00:05:00+07:00");
  await assertPeriodOpen(prisma, date);
  const lines = [
    { accountId: s0006.coaAccountId, debit: 3_000_000, memo: "Pembayaran Mas Rizal Sept sudah tercermin di saldo awal 1 Nov" },
    { accountId: spay.coaAccountId, debit: 200_000, memo: "Sisihan kompensasi 3 Nov ternetralkan oleh JU-202611-0005" },
    { accountId: s5984.coaAccountId, credit: 240_000, memo: "LPG 40rb + sisihan 200rb 3 Nov ternetralkan oleh JU-202611-0005" },
    { accountCode: COA.EKUITAS_SALDO_AWAL, credit: 2_960_000, memo: "Penyeimbang koreksi saldo awal" },
  ];
  const before = { s5984: await balance(s5984.coaAccountId), s0006: await balance(s0006.coaAccountId), spay: await balance(spay.coaAccountId) };
  console.log("Saldo aplikasi  sekarang  →  sesudah koreksi");
  console.log(`  ${s5984.name}: ${idr(before.s5984)} → ${idr(before.s5984 - 240_000)}`);
  console.log(`  ${s0006.name}: ${idr(before.s0006)} → ${idr(before.s0006 + 3_000_000)}`);
  console.log(`  ${spay.name}: ${idr(before.spay)} → ${idr(before.spay + 200_000)}`);

  if (!apply) {
    console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan --jalankan");
    return;
  }
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  const actor = { id: owner?.id ?? "skrip", name: "skrip koreksi-saldo-nov" };
  const j = await prisma.$transaction((tx) =>
    postJournal(tx, { date, storeId: null, description: "Koreksi saldo awal hasil audit 5 Nov (pembayaran Rizal Sept & penyesuaian 4 Nov)", source: "SALDO_AWAL", sourceId: SOURCE_ID, actor, lines }),
  );
  console.log(`\nTersimpan: ${j.number}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
