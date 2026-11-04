/*
 * Catat pemasukan penjualan untuk withdraw saldo penjual marketplace yang SUDAH dibukukan (sekali jalan, aman diulang).
 *
 *   npm run withdraw:pemasukan               -> hanya MENAMPILKAN rencana (aman, tidak menyimpan apa pun)
 *   npm run withdraw:pemasukan -- --jalankan -> menyimpan
 *
 * Sejak PR #33, withdraw dari rekening bertanda "Saldo penjual marketplace" otomatis dicatat juga sebagai pemasukan
 * (Dr Saldo Penjual / Cr Penjualan). Withdraw lama belum, sehingga saldo penjual minus dan omzet toko tidak tercatat.
 * Skrip ini menambah jurnal susulan per withdraw lama, bertanggal sama (jurnal lama tidak diubah).
 * Bila periodenya sudah ditutup, jurnal dicatat hari ini.
 *
 * WAJIB backup dulu: npm run backup
 */
import { PrismaClient } from "@prisma/client";
import { assertPeriodOpen, COA, postJournal } from "../src/lib/accounting";
import { WITHDRAW_INCOME_SOURCE, withdrawIncomeLines } from "../src/lib/finance";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const idr = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
const day = (d: Date) => d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric" });

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  const sellers = await prisma.bankAccount.findMany({ where: { marketplace: true } });
  if (!sellers.length) {
    console.log('Tidak ada rekening bertanda "Saldo penjual marketplace". Tandai dulu di Pengaturan › Rekening.');
    return;
  }
  console.log(`Rekening saldo penjual: ${sellers.map((b) => b.name).join(", ")}`);
  const sales = await prisma.coaAccount.findUniqueOrThrow({ where: { code: COA.PENJUALAN } });
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  const actor = { id: owner?.id ?? "skrip", name: "skrip withdraw-pemasukan" };
  const txs = await prisma.financeTransaction.findMany({
    where: { status: "DIBUKUKAN", direction: "TRANSFER", accountId: { in: sellers.map((b) => b.id) }, journalId: { not: null }, deletedAt: null },
    include: { store: true },
    orderBy: { date: "asc" },
  });
  let count = 0;
  let total = 0;
  for (const t of txs) {
    const seller = sellers.find((b) => b.id === t.accountId)!;
    const own = await prisma.journalLine.findFirst({ where: { journalId: t.journalId!, accountId: sales.id, credit: { gt: 0 } } });
    const extra = await prisma.journal.findFirst({ where: { source: WITHDRAW_INCOME_SOURCE, sourceId: t.id } });
    if (own || extra) continue;
    const date = await assertPeriodOpen(prisma, t.date).then(() => t.date, () => new Date());
    count++;
    total += Number(t.amount);
    console.log(`  + ${t.number} ${day(t.date)} ${seller.name}${t.store ? ` (${t.store.name})` : ""}: ${idr(Number(t.amount))}${date !== t.date ? " · periode ditutup, dicatat hari ini" : ""}`);
    if (apply) {
      await prisma.$transaction(async (tx) => {
        await postJournal(tx, { date, storeId: t.storeId, description: `Pemasukan penjualan dari withdraw ${t.number}`, source: WITHDRAW_INCOME_SOURCE, sourceId: t.id, actor, lines: withdrawIncomeLines(seller.coaAccountId, seller.name, Number(t.amount)) });
      });
    }
  }
  console.log(count ? `\n${count} withdraw lama, total pemasukan ${idr(total)}` : "\nSemua withdraw sudah tercatat sebagai pemasukan. Tidak ada yang diubah.");
  // Pemasukan yang langsung dicatat ke saldo penjual: bisa dobel dengan pemasukan dari withdraw
  const direct = await prisma.financeTransaction.findMany({ where: { status: "DIBUKUKAN", direction: "MASUK", accountId: { in: sellers.map((b) => b.id) }, deletedAt: null }, orderBy: { date: "asc" } });
  if (direct.length) {
    console.log(`\nPERIKSA: ${direct.length} pemasukan dicatat langsung ke saldo penjual (bisa terhitung dobel dengan withdraw):`);
    for (const t of direct.slice(0, 20)) console.log(`  ${t.number} ${day(t.date)} ${idr(Number(t.amount))} ${t.note?.slice(0, 50) ?? ""}`);
    console.log("  Bila itu pencairan yang nanti di-withdraw juga, batalkan transaksi tsb di menu Transaksi.");
  }
  if (!apply && count) console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu  npm run withdraw:pemasukan -- --jalankan");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
