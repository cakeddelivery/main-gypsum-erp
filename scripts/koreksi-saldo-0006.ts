/*
 * Koreksi saldo Seabank 0006 (tabungan Nabung Bayar Hutang) hasil audit 8 Nov 2026. Aman diulang.
 *
 *   npm run koreksi:saldo-0006               -> PRATINJAU saja
 *   npm run koreksi:saldo-0006 -- --jalankan -> menyimpan 1 jurnal koreksi
 *
 * Masalah: "Atur saldo" 4 Nov (JU-202611-0005) menambah Rp8.663.455 karena saat itu buku 0006 masih 0.
 * Sesudahnya dicatat bayar cicilan SPinjam Rp3.773.324 (1 Nov) & bayar Mas Rizal Rp3.000.000 (2 Nov)
 * bertanggal SEBELUM 4 Nov, jadi tidak ikut "terserap". Menurut owner, saldo asli 0006:
 *   awal 1 Nov Rp6.773.324 → dipakai 2 pembayaran di atas → 0 → sisihan Rp300rb/hari
 *   = akhir 4 Nov Rp1.200.000, akhir 7 Nov Rp2.100.000.
 * Buku akhir 4 Nov Rp3.090.131 → selisih Rp1.890.131 dikurangi dari 0006 (lawan: Ekuitas Saldo Awal),
 * tanggal sama dengan JU-202611-0005.
 *
 * WAJIB backup dulu: npm run backup
 */
import { PrismaClient } from "@prisma/client";
import { assertPeriodOpen, COA, postJournal } from "../src/lib/accounting";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const SOURCE_ID = "AUDIT-SALDO-0006-2026-11-08";
const AMOUNT = 1_890_131;
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(n).toLocaleString("id-ID");

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);

  const done = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: SOURCE_ID } });
  if (done) {
    console.log(`Koreksi sudah pernah dibukukan (${done.number}). Tidak ada yang diubah.`);
    return;
  }
  const bank = await prisma.bankAccount.findUnique({ where: { code: "SEABANK0006" } });
  if (!bank) throw new Error("Rekening SEABANK0006 tidak ditemukan");
  const until = async (iso: string) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: bank.coaAccountId, journal: { date: { lt: new Date(iso) } } }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };

  // Pastikan kondisinya masih sama dengan saat audit
  const adj = await prisma.journal.findUnique({ where: { number: "JU-202611-0005" }, include: { lines: true } });
  const adj0006 = adj?.lines.filter((l) => l.accountId === bank.coaAccountId).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
  if (!adj || adj.source !== "SALDO_AWAL" || adj0006 !== 8_663_455) throw new Error("Jurnal JU-202611-0005 tidak sesuai hasil audit. Hentikan, kabari Claude.");
  const end4 = await until("2026-11-05T00:00:00+07:00");
  if (end4 !== 1_200_000 + AMOUNT) throw new Error(`Saldo buku 0006 akhir 4 Nov ${idr(end4)}, bukan ${idr(1_200_000 + AMOUNT)} seperti saat audit. Hentikan, kabari Claude.`);
  const end7 = await until("2026-11-08T00:00:00+07:00");
  const now = await until("2100-01-01T00:00:00+07:00");

  console.log(`${bank.name}           sekarang  →  sesudah koreksi`);
  console.log(`  akhir 4 Nov:  ${idr(end4)} → ${idr(end4 - AMOUNT)}   (asli Rp1.200.000)`);
  console.log(`  akhir 7 Nov:  ${idr(end7)} → ${idr(end7 - AMOUNT)}   (asli Rp2.100.000)`);
  console.log(`  saldo kini:   ${idr(now)} → ${idr(now - AMOUNT)}`);

  if (!apply) {
    console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
    return;
  }
  const date = adj.date;
  await assertPeriodOpen(prisma, date);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  const actor = { id: owner?.id ?? "skrip", name: "skrip koreksi-saldo-0006" };
  const j = await prisma.$transaction((tx) =>
    postJournal(tx, {
      date,
      storeId: null,
      description: "Koreksi saldo Seabank 0006 (audit 8 Nov): JU-202611-0005 tidak menyerap bayar SPinjam 1 Nov & Mas Rizal 2 Nov",
      source: "SALDO_AWAL",
      sourceId: SOURCE_ID,
      actor,
      lines: [
        { accountCode: COA.EKUITAS_SALDO_AWAL, debit: AMOUNT, memo: "Penyeimbang koreksi saldo 0006" },
        { accountId: bank.coaAccountId, credit: AMOUNT, memo: "Saldo asli akhir 4 Nov Rp1.200.000 (sisihan 1–4 Nov), bukan Rp3.090.131" },
      ],
    }),
  );
  console.log(`\nTersimpan: ${j.number}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
