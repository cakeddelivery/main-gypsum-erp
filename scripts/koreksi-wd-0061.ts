/*
 * Koreksi tanggal TRX-202611-0061 (withdraw TikTok toko Main Gypsum Rp684.934 → Seabank 5984). Aman diulang.
 *
 *   npm run koreksi:wd-0061                 -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:wd-0061 -- --jalankan   -> menyimpan
 *
 * Di mutasi Seabank 5984 uang ini masuk tanggal 5 Nov 2026, di aplikasi tercatat di tanggal lain.
 * Transaksi yang sudah dibukukan tidak boleh dihapus, jadi:
 *   1. TRX-202611-0061 dibatalkan (jurnal dibalik, pemasukan penjualannya ikut dibalik);
 *   2. dicatat ulang tanggal 5 Nov 2026 (jam, toko, rekening, catatan & bukti sama) lalu dibukukan.
 * Pemasukan penjualan TikTok-nya ikut pindah ke 5 Nov.
 *
 * Langkah 3 skrip koreksi:transaksi-nov melakukan hal yang sama dengan kunci yang sama
 * (KOREKSI-TGL-TRX-202611-0061): bila salah satunya sudah dijalankan, yang lain hanya menulis "sudah dikoreksi".
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen } from "../src/lib/accounting";
import { approveAndBook, cancelBookedTransaction, createTransaction } from "../src/lib/finance";

export const REDATE = { number: "TRX-202611-0061", amount: 684_934, day: "2026-11-05" };
export const REDATE_KEY = `KOREKSI-TGL-${REDATE.number}`;
const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");
const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d);
const hhmm = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

export type Hasil = "SUDAH" | "PRATINJAU" | "DIKOREKSI";

export async function koreksiWd0061(apply: boolean, log: (s: string) => void = console.log): Promise<{ hasil: Hasil; number?: string }> {
  const done = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: REDATE_KEY } });
  if (done?.status === "DIBUKUKAN") {
    log(`= ${REDATE.number} sudah dikoreksi: ${done.number} tanggal ${day(done.date)}. Tidak ada yang diubah.`);
    return { hasil: "SUDAH", number: done.number };
  }
  const tiktok = await prisma.bankAccount.findUnique({ where: { code: "SALDO_TIKTOK" } });
  const seabank = await prisma.bankAccount.findUnique({ where: { code: "SEABANK" } });
  if (!tiktok || !seabank) throw new Error("Rekening SALDO_TIKTOK / SEABANK tidak ditemukan");
  const wd = await prisma.financeTransaction.findUnique({ where: { number: REDATE.number }, include: { store: true } });
  if (!wd) throw new Error(`${REDATE.number} tidak ditemukan`);
  if (wd.direction !== "TRANSFER" || wd.accountId !== tiktok.id || wd.toAccountId !== seabank.id || Number(wd.amount) !== REDATE.amount) {
    throw new Error(`${REDATE.number} bukan withdraw TikTok → Seabank 5984 ${idr(REDATE.amount)}. Hentikan, kabari Claude.`);
  }
  const oldDay = day(wd.date);
  log(`${REDATE.number}: withdraw TikTok ${wd.store?.code ?? "?"} ${idr(REDATE.amount)}, tanggal ${oldDay} ${hhmm(wd.date)}, status ${wd.status}`);

  // Sudah dibatalkan & dicatat ulang manual? Cari withdraw TikTok lain dengan nominal sama yang masih dibukukan.
  const twin = await prisma.financeTransaction.findFirst({
    where: { id: { not: wd.id }, status: "DIBUKUKAN", direction: "TRANSFER", accountId: tiktok.id, amount: BigInt(REDATE.amount) },
    orderBy: { date: "asc" },
  });
  if (wd.status === "DIBUKUKAN" && oldDay === REDATE.day) {
    log(`= sudah bertanggal ${REDATE.day}, tidak perlu dikoreksi.`);
    return { hasil: "SUDAH", number: wd.number };
  }
  if (twin) {
    if (wd.status === "DIBUKUKAN") throw new Error(`Ada ${twin.number} (${day(twin.date)}) dengan nominal sama yang juga dibukukan. Hentikan, kabari Claude.`);
    log(`= ${REDATE.number} sudah ${wd.status} dan sudah dicatat ulang: ${twin.number} tanggal ${day(twin.date)}. Tidak ada yang diubah.`);
    if (day(twin.date) !== REDATE.day) log(`  Perhatian: ${twin.number} bertanggal ${day(twin.date)}, bukan ${REDATE.day}. Kabari Claude.`);
    return { hasil: "SUDAH", number: twin.number };
  }
  if (wd.status !== "DIBUKUKAN" && wd.status !== "DIBATALKAN") {
    throw new Error(`${REDATE.number} berstatus ${wd.status} (belum dibukukan). Perbaiki tanggalnya langsung di menu Transaksi, tidak perlu skrip.`);
  }

  // Jurnal balik harus jatuh di tanggal lama. Bila periodenya sudah ditutup, jangan lanjut (jurnal balik akan salah tanggal).
  const newDate = new Date(`${REDATE.day}T${hhmm(wd.date)}:00+07:00`);
  if (wd.status === "DIBUKUKAN") {
    await assertPeriodOpen(prisma, wd.date).catch(() => {
      throw new Error(`Periode tanggal ${oldDay} sudah ditutup, jurnal balik tidak bisa di tanggal itu. Hentikan, kabari Claude.`);
    });
  }
  await assertPeriodOpen(prisma, newDate);

  if (wd.status === "DIBUKUKAN") log(`  - batalkan ${REDATE.number} (jurnal dibalik di tanggal ${oldDay}, pemasukan penjualannya ikut dibalik)`);
  else log(`  = ${REDATE.number} sudah DIBATALKAN, belum ada penggantinya`);
  log(`  + catat ulang ${idr(REDATE.amount)} tanggal ${REDATE.day} pukul ${hhmm(wd.date)}, toko ${wd.store?.code ?? "?"}, TikTok → Seabank 5984, lalu dibukukan`);
  if (!apply) return { hasil: "PRATINJAU" };

  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip koreksi-wd-0061" };
  if (wd.status === "DIBUKUKAN") {
    const { reversal } = await cancelBookedTransaction(wd.id, actor, `Salah tanggal: masuk Seabank 5984 tanggal ${REDATE.day}`);
    log(`    → ${REDATE.number} dibatalkan, jurnal balik ${reversal.number}`);
  }
  const t =
    done ??
    (
      await createTransaction(
        {
          direction: "TRANSFER",
          amount: REDATE.amount,
          date: newDate,
          accountId: wd.accountId,
          toAccountId: wd.toAccountId,
          storeId: wd.storeId,
          counterparty: wd.counterparty,
          note: `${wd.note ?? ""} (koreksi tanggal ${REDATE.number})`.trim(),
          proofPath: wd.proofPath,
          proofMime: wd.proofMime,
          idempotencyKey: REDATE_KEY,
        },
        "MANUAL",
        actor,
        { submit: true },
      )
    ).transaction;
  const { transaction: booked } = await approveAndBook(t.id, actor, "Koreksi audit saldo Nov: tanggal withdraw");
  log(`    → ${booked.number} dibukukan tanggal ${REDATE.day}`);
  return { hasil: "DIKOREKSI", number: booked.number };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-wd-0061.ts")) {
  const apply = process.argv.includes("--jalankan");
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiWd0061(apply)
    .then((r) => {
      if (r.hasil === "PRATINJAU") console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
