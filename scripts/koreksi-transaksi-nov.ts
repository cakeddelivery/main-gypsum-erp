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
  if (!apply) console.log("\nIni baru PRATINJAU. Untuk menyimpan, jalankan lagi dengan --jalankan");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
