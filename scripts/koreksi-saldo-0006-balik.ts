/*
 * Balik koreksi saldo Seabank 0006 yang salah (audit 9 Nov 2026). Aman diulang.
 *
 *   npm run koreksi:saldo-0006-balik                 -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:saldo-0006-balik -- --jalankan   -> menyimpan
 *
 * Skrip koreksi:saldo-0006 (PR #38) membukukan JU-202611-0136: 0006 dikurangi Rp1.890.131, karena saat itu
 * dikira saldo 0006 habis (0) setelah bayar SPinjam 1 Nov & Mas Rizal 2 Nov. Menurut catatan owner dan aplikasi
 * SeaBank, sesudah dua pembayaran itu masih sisa Rp1.900.009:
 *   asli akhir 4 Nov = 1.900.009 + 4 × 300.000 sisihan = Rp3.100.009
 *   asli 9 Nov pagi  = 1.900.009 + 8 × 300.000 − 2.300.000 plastik klip = Rp2.000.009 (sama dengan aplikasi SeaBank)
 * Buku akhir 4 Nov sebelum koreksi Rp3.090.131 (kurang Rp9.878), sesudah koreksi Rp1.200.000.
 *
 * Perbaikan (tanggal sama dengan JU-202611-0136, 4 Nov; tidak ada yang dihapus):
 *   1. jurnal balik JU-202611-0136: 0006 +Rp1.890.131, Ekuitas Saldo Awal −Rp1.890.131
 *   2. penyesuaian sisa: Dr Seabank 0006 Rp9.878 / Cr Ekuitas Saldo Awal Rp9.878
 * Hasil: buku 0006 akhir 4 Nov = Rp3.100.009. Rekening lain tidak berubah (lawannya hanya Ekuitas Saldo Awal).
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen, COA, postJournal, reverseJournal } from "../src/lib/accounting";

export const WRONG_SOURCE_ID = "AUDIT-SALDO-0006-2026-11-08";
export const WRONG_AMOUNT = 1_890_131;
export const REST_SOURCE_ID = "AUDIT-SALDO-0006-2026-11-09-SISA";
export const REST_AMOUNT = 9_878;
export const TARGET_END4 = 3_100_009;
const END4 = new Date("2026-11-05T00:00:00+07:00");
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(n).toLocaleString("id-ID");

export type Hasil = "SUDAH" | "PRATINJAU" | "DIKOREKSI";

export async function koreksiSaldo0006Balik(apply: boolean, log: (s: string) => void = console.log): Promise<{ hasil: Hasil; journals: string[] }> {
  const bank = await prisma.bankAccount.findUnique({ where: { code: "SEABANK0006" } });
  if (!bank) throw new Error("Rekening SEABANK0006 tidak ditemukan");
  const bal = async (until?: Date) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: bank.coaAccountId, ...(until ? { journal: { date: { lt: until } } } : {}) }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };

  const wrong = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: WRONG_SOURCE_ID, reversalOfId: null }, include: { lines: true } });
  if (!wrong) throw new Error("Jurnal koreksi:saldo-0006 (JU-202611-0136) tidak ditemukan. Tidak ada yang perlu dibalik; kabari Claude.");
  const wrong0006 = wrong.lines.filter((l) => l.accountId === bank.coaAccountId).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
  if (wrong0006 !== -WRONG_AMOUNT) throw new Error(`${wrong.number} tidak mengurangi 0006 sebesar ${idr(WRONG_AMOUNT)}. Hentikan, kabari Claude.`);
  const reversed = await prisma.journal.findFirst({ where: { reversalOfId: wrong.id } });
  const rest = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: REST_SOURCE_ID } });

  if (reversed && rest) {
    log(`= Sudah diperbaiki: ${wrong.number} dibalik oleh ${reversed.number}, penyesuaian sisa ${rest.number}. Tidak ada yang diubah.`);
    return { hasil: "SUDAH", journals: [reversed.number, rest.number] };
  }

  // Pastikan kondisi masih sama dengan saat audit: akhir 4 Nov + perbaikan yang belum dibukukan = Rp3.100.009
  const pending = (reversed ? 0 : WRONG_AMOUNT) + (rest ? 0 : REST_AMOUNT);
  const end4 = await bal(END4);
  if (end4 + pending !== TARGET_END4) {
    throw new Error(`Saldo buku 0006 akhir 4 Nov ${idr(end4)}; ditambah perbaikan ${idr(pending)} jadi ${idr(end4 + pending)}, bukan ${idr(TARGET_END4)}. Hentikan, kabari Claude.`);
  }
  const date = wrong.date;
  await assertPeriodOpen(prisma, date).catch(() => {
    throw new Error(`Periode tanggal ${wrong.number} sudah ditutup, jurnal balik tidak bisa di tanggal itu. Hentikan, kabari Claude.`);
  });

  const now = await bal();
  log(`${bank.name}            sekarang  →  sesudah perbaikan`);
  log(`  akhir 4 Nov:  ${idr(end4)} → ${idr(end4 + pending)}   (asli Rp3.100.009)`);
  log(`  saldo kini:   ${idr(now)} → ${idr(now + pending)}`);
  log("Rekening lain tidak berubah (lawan jurnal: Ekuitas Saldo Awal).\n");
  if (reversed) log(`  = ${wrong.number} sudah dibalik (${reversed.number})`);
  else log(`  + jurnal balik ${wrong.number}: 0006 +${idr(WRONG_AMOUNT)}`);
  if (rest) log(`  = penyesuaian sisa sudah ada (${rest.number})`);
  else log(`  + penyesuaian sisa: 0006 +${idr(REST_AMOUNT)} (lawan Ekuitas Saldo Awal)`);
  if (!apply) return { hasil: "PRATINJAU", journals: [] };

  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  const actor = { id: owner?.id ?? "skrip", name: "skrip koreksi-saldo-0006-balik" };
  const journals = await prisma.$transaction(async (tx) => {
    const out: string[] = [];
    if (!reversed) out.push((await reverseJournal(tx, wrong.id, date, actor, "salah dasar: sesudah bayar SPinjam & Rizal saldo 0006 masih Rp1.900.009, bukan 0")).number);
    if (!rest) {
      const j = await postJournal(tx, {
        date,
        storeId: null,
        description: "Penyesuaian saldo Seabank 0006 (audit 9 Nov): akhir 4 Nov asli Rp3.100.009",
        source: "SALDO_AWAL",
        sourceId: REST_SOURCE_ID,
        actor,
        lines: [
          { accountId: bank.coaAccountId, debit: REST_AMOUNT, memo: "Sisa selisih saldo 0006 akhir 4 Nov (buku Rp3.090.131, asli Rp3.100.009)" },
          { accountCode: COA.EKUITAS_SALDO_AWAL, credit: REST_AMOUNT, memo: "Penyeimbang penyesuaian saldo 0006" },
        ],
      });
      out.push(j.number);
    }
    return out;
  });
  log(`\nTersimpan: ${journals.join(", ")}. Saldo 0006 kini ${idr(await bal())}`);
  return { hasil: "DIKOREKSI", journals };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-saldo-0006-balik.ts")) {
  const apply = process.argv.includes("--jalankan");
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiSaldo0006Balik(apply)
    .then((r) => {
      if (r.hasil === "PRATINJAU") console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
