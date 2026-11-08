/*
 * Koreksi transaksi hasil pencocokan mutasi Seabank 5984 (5 Nov 2026). Aman diulang.
 *
 *   npx tsx scripts/koreksi-transaksi-nov.ts             -> PRATINJAU
 *   npx tsx scripts/koreksi-transaksi-nov.ts --jalankan  -> menyimpan
 *
 * 1. Catat 2 withdraw TikTok toko Main Gypsum yang masuk Seabank 5984 tanggal 2 Nov (pengajuan 31 Okt & 1 Nov):
 *    Rp966.222 dan Rp893.533. Pemasukan penjualannya ikut tercatat otomatis (saldo penjual marketplace).
 * 2. TRX-202611-0011 pembelian magnet tercatat Rp2.000, di mutasi Rp289.335: dibatalkan (jurnal dibalik)
 *    lalu dicatat ulang dengan nominal benar, kategori/rincian sama.
 * 3. TRX-202611-0061 withdraw TikTok MG Rp684.934 salah tanggal: dibatalkan (jurnal dibalik) lalu dicatat ulang
 *    tanggal 5 Nov (jam, toko, rekening, bukti sama). Pemasukan penjualannya ikut pindah tanggal.
 */
import { PrismaClient } from "@prisma/client";
import { approveAndBook, cancelBookedTransaction, createTransaction } from "../src/lib/finance";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");

const WITHDRAWS = [
  { key: "WD-TIKTOK-MG-3747877864213283933", amount: 966_222, at: "2026-11-02T09:50:00+07:00", note: "WD tiktok MG (pengajuan 31 Okt, ref 3747877864213283933)" },
  { key: "WD-TIKTOK-MG-3749234774551921757", amount: 893_533, at: "2026-11-02T11:19:00+07:00", note: "WD tiktok MG (pengajuan 1 Nov, ref 3749234774551921757)" },
];
const FIX = { number: "TRX-202611-0011", wrong: 2_000, right: 289_335 };
const REDATE = { number: "TRX-202611-0061", amount: 684_934, day: "2026-11-05" };

async function main() {
  console.log(`mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip koreksi-transaksi-nov" };
  const tiktok = await prisma.bankAccount.findUnique({ where: { code: "SALDO_TIKTOK" } });
  const seabank = await prisma.bankAccount.findUnique({ where: { code: "SEABANK" } });
  const mg = await prisma.store.findUnique({ where: { code: "MG" } });
  if (!tiktok || !seabank || !mg) throw new Error("Rekening SALDO_TIKTOK / SEABANK atau toko MG tidak ditemukan");

  console.log("1. Withdraw TikTok MG → Seabank 5984");
  for (const w of WITHDRAWS) {
    const exist = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: w.key } });
    if (exist?.status === "DIBUKUKAN") {
      console.log(`  = ${idr(w.amount)} sudah tercatat (${exist.number})`);
      continue;
    }
    console.log(`  + 2 Nov ${idr(w.amount)} ${w.note}`);
    if (!apply) continue;
    const t = exist ?? (await createTransaction({ direction: "TRANSFER", amount: w.amount, date: new Date(w.at), accountId: tiktok.id, toAccountId: seabank.id, storeId: mg.id, counterparty: "Tokopedia", note: w.note, idempotencyKey: w.key }, "MANUAL", actor, { submit: true })).transaction;
    await approveAndBook(t.id, actor, "Koreksi audit saldo 5 Nov");
    console.log(`    → ${t.number} dibukukan`);
  }

  console.log(`\n2. ${FIX.number}: ${idr(FIX.wrong)} → ${idr(FIX.right)}`);
  const key = `KOREKSI-${FIX.number}`;
  const done = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: key } });
  const old = await prisma.financeTransaction.findUnique({ where: { number: FIX.number }, include: { splits: true } });
  if (done?.status === "DIBUKUKAN") {
    console.log(`  = sudah dikoreksi (${done.number})`);
  } else if (!old) {
    throw new Error(`${FIX.number} tidak ditemukan`);
  } else {
    if (old.direction !== "KELUAR" || old.accountId !== seabank.id) throw new Error(`${FIX.number} bukan pengeluaran Seabank 5984. Hentikan, kabari Claude.`);
    if (old.status === "DIBUKUKAN" && Number(old.amount) !== FIX.wrong) throw new Error(`${FIX.number} nominalnya ${idr(Number(old.amount))}, bukan ${idr(FIX.wrong)}. Hentikan, kabari Claude.`);
    if (old.splits.length > 1) throw new Error(`${FIX.number} punya ${old.splits.length} rincian; koreksi manual saja di menu Transaksi.`);
    console.log(`  - batalkan ${FIX.number} (${old.counterparty ?? ""} ${old.note ?? ""})`.trimEnd());
    console.log(`  + catat ulang ${idr(FIX.right)}, kategori & rincian sama`);
    if (apply) {
      if (old.status === "DIBUKUKAN") await cancelBookedTransaction(old.id, actor, `Salah nominal: di mutasi ${idr(FIX.right)}`);
      const s = old.splits[0];
      const t =
        done ??
        (await createTransaction(
          {
            direction: "KELUAR",
            amount: FIX.right,
            date: old.date,
            accountId: old.accountId,
            categoryId: old.categoryId,
            storeId: old.storeId,
            counterparty: old.counterparty,
            note: `${old.note ?? ""} (koreksi nominal ${FIX.number})`.trim(),
            proofPath: old.proofPath,
            proofMime: old.proofMime,
            idempotencyKey: key,
            splits: s ? [{ amount: FIX.right, categoryId: s.categoryId, itemId: s.itemId, qty: s.qty === null ? null : Number(s.qty), note: s.note }] : null,
          },
          "MANUAL",
          actor,
          { submit: true },
        )).transaction;
      await approveAndBook(t.id, actor, "Koreksi audit saldo 5 Nov");
      console.log(`    → ${t.number} dibukukan`);
    }
  }
  console.log(`\n3. ${REDATE.number}: tanggal dipindah ke 5 Nov`);
  const rkey = `KOREKSI-TGL-${REDATE.number}`;
  const rdone = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: rkey } });
  const wd = await prisma.financeTransaction.findUnique({ where: { number: REDATE.number } });
  if (rdone?.status === "DIBUKUKAN") {
    console.log(`  = sudah dikoreksi (${rdone.number})`);
  } else if (!wd) {
    throw new Error(`${REDATE.number} tidak ditemukan`);
  } else {
    if (wd.direction !== "TRANSFER" || wd.accountId !== tiktok.id || wd.toAccountId !== seabank.id || Number(wd.amount) !== REDATE.amount) {
      throw new Error(`${REDATE.number} bukan withdraw TikTok → Seabank 5984 ${idr(REDATE.amount)}. Hentikan, kabari Claude.`);
    }
    // Jam sama, tanggal 5 Nov (WIB)
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(wd.date);
    const newDate = new Date(`${REDATE.day}T${hm}:00+07:00`);
    const oldDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(wd.date);
    // Sudah dibatalkan & dicatat ulang manual? Cari withdraw lain dengan nominal sama yang masih dibukukan.
    const twin = await prisma.financeTransaction.findFirst({
      where: { id: { not: wd.id }, status: "DIBUKUKAN", direction: "TRANSFER", accountId: tiktok.id, amount: BigInt(REDATE.amount) },
      orderBy: { date: "asc" },
    });
    const twinDay = twin ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(twin.date) : null;
    if (oldDay === REDATE.day && wd.status === "DIBUKUKAN") {
      console.log(`  = sudah bertanggal ${REDATE.day}, tidak perlu dikoreksi`);
    } else if (wd.status !== "DIBUKUKAN" && twin) {
      console.log(`  = ${REDATE.number} sudah dibatalkan (${wd.status}) dan sudah dicatat ulang manual: ${twin.number} tanggal ${twinDay}. Tidak ada yang diubah.`);
      if (twinDay !== REDATE.day) console.log(`    Perhatian: ${twin.number} bertanggal ${twinDay}, bukan ${REDATE.day}. Kabari Claude.`);
    } else if (wd.status === "DIBUKUKAN" && twin) {
      throw new Error(`Ada ${twin.number} (${twinDay}) dengan nominal sama yang juga dibukukan. Hentikan, kabari Claude.`);
    } else {
      if (wd.status === "DIBUKUKAN") console.log(`  - batalkan ${REDATE.number} (tanggal ${oldDay}, ${wd.note ?? ""})`.trimEnd());
      else console.log(`  = ${REDATE.number} sudah ${wd.status}, belum ada pengganti`);
      console.log(`  + catat ulang ${idr(REDATE.amount)} tanggal ${REDATE.day} pukul ${hm}, toko & rekening sama`);
      if (apply) {
        if (wd.status === "DIBUKUKAN") await cancelBookedTransaction(wd.id, actor, `Salah tanggal: masuk Seabank 5984 tanggal ${REDATE.day}`);
        const t =
          rdone ??
          (await createTransaction(
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
              idempotencyKey: rkey,
            },
            "MANUAL",
            actor,
            { submit: true },
          )).transaction;
        await approveAndBook(t.id, actor, "Koreksi audit saldo 5 Nov");
        console.log(`    → ${t.number} dibukukan`);
      }
    }
  }

  if (!apply) console.log("\nIni baru PRATINJAU. Untuk menyimpan, jalankan lagi dengan --jalankan");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
