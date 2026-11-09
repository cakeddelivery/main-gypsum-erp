/*
 * Koreksi tanggal withdraw TikTok (MG & DL) yang dicatat lewat bot dengan tanggal/jam input, bukan tanggal dana
 * masuk (bukti WD TikTok tidak mencantumkan tanggal). Tanggal benar = "Ditransfer ke bank" di riwayat Keuangan
 * TikTok Seller (audit 9 Nov 2026). Aman diulang.
 *
 *   npm run koreksi:tanggal-wd                 -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:tanggal-wd -- --jalankan   -> menyimpan
 *
 * Transaksi dibukukan tidak dihapus: dibatalkan (jurnal balik, pemasukan penjualannya ikut dibalik) lalu dicatat
 * ulang dengan tanggal benar (rekening, toko, catatan, bukti sama) dan dibukukan. Saldo akhir tidak berubah,
 * hanya urutan/tanggalnya.
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen } from "../src/lib/accounting";
import { approveAndBook, cancelBookedTransaction, createTransaction } from "../src/lib/finance";

export type Redate = { number: string; amount: number; at: string; label: string };
export const WD_TIKTOK: Redate[] = [
  { number: "TRX-202611-0071", amount: 375_227, at: "2026-11-05T22:08", label: "WD TikTok DL" },
  { number: "TRX-202611-0079", amount: 463_256, at: "2026-11-06T19:49", label: "WD TikTok MG" },
  { number: "TRX-202611-0088", amount: 887_136, at: "2026-11-07T18:51", label: "WD TikTok MG" },
  { number: "TRX-202611-0089", amount: 1_281_965, at: "2026-11-07T19:43", label: "WD TikTok DL" },
  { number: "TRX-202611-0098", amount: 649_818, at: "2026-11-08T20:54", label: "WD TikTok MG" },
  { number: "TRX-202611-0099", amount: 359_134, at: "2026-11-08T20:54", label: "WD TikTok DL" },
];

const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");
const wib = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16);
const keyOf = (number: string) => `KOREKSI-TGL-${number}`;

export async function koreksiTanggalWd(list: Redate[], apply: boolean, log: (s: string) => void = console.log) {
  const out = { done: 0, planned: 0, changed: [] as string[] };
  // Periksa semua dulu; bila satu tidak sesuai, tidak ada yang diubah
  const plan: { r: Redate; id: string; status: string; newDate: Date }[] = [];
  for (const r of list) {
    const newDate = new Date(`${r.at}:00+07:00`);
    const fixed = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: keyOf(r.number) } });
    if (fixed?.status === "DIBUKUKAN") {
      log(`= ${r.number} sudah dikoreksi: ${fixed.number} tanggal ${wib(fixed.date)}`);
      out.done++;
      continue;
    }
    const t = await prisma.financeTransaction.findUnique({ where: { number: r.number } });
    if (!t) throw new Error(`${r.number} tidak ditemukan. Hentikan, kabari Claude.`);
    const from = t.accountId ? await prisma.bankAccount.findUnique({ where: { id: t.accountId } }) : null;
    if (t.direction !== "TRANSFER" || !from?.marketplace || Number(t.amount) !== r.amount) {
      throw new Error(`${r.number} bukan withdraw saldo penjual ${idr(r.amount)} (tercatat ${t.direction} ${idr(Number(t.amount))}). Hentikan, kabari Claude.`);
    }
    if (t.status === "DIBUKUKAN" && wib(t.date) === wib(newDate)) {
      log(`= ${r.number} sudah bertanggal ${wib(newDate)}`);
      out.done++;
      continue;
    }
    if (t.status !== "DIBUKUKAN" && t.status !== "DIBATALKAN") throw new Error(`${r.number} berstatus ${t.status}. Ubah tanggalnya langsung di menu Transaksi.`);
    if (t.status === "DIBUKUKAN") {
      await assertPeriodOpen(prisma, t.date).catch(() => {
        throw new Error(`Periode tanggal ${r.number} sudah ditutup. Hentikan, kabari Claude.`);
      });
    }
    await assertPeriodOpen(prisma, newDate);
    plan.push({ r, id: t.id, status: t.status, newDate });
    log(`~ ${r.number} ${r.label} ${idr(r.amount)}: ${wib(t.date)} → ${wib(newDate)}${t.status === "DIBATALKAN" ? " (sudah dibatalkan, tinggal dicatat ulang)" : ""}`);
  }
  out.planned = plan.length;
  if (!apply || !plan.length) return out;

  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip koreksi-tanggal-wd" };
  for (const p of plan) {
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: p.id } });
    if (t.status === "DIBUKUKAN") await cancelBookedTransaction(t.id, actor, `Salah tanggal: dana masuk ${wib(p.newDate)} (riwayat TikTok Seller)`);
    const pending = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: keyOf(p.r.number) } });
    const n =
      pending ??
      (
        await createTransaction(
          {
            direction: "TRANSFER",
            amount: p.r.amount,
            date: p.newDate,
            accountId: t.accountId,
            toAccountId: t.toAccountId,
            storeId: t.storeId,
            counterparty: t.counterparty,
            note: `${t.note ?? ""} (koreksi tanggal ${t.number})`.trim().slice(0, 500),
            proofPath: t.proofPath,
            proofMime: t.proofMime,
            reserveLink: { skip: true },
            idempotencyKey: keyOf(p.r.number),
          },
          "MANUAL",
          actor,
          { submit: true },
        )
      ).transaction;
    if (n.status !== "MENUNGGU_KONFIRMASI") await prisma.financeTransaction.update({ where: { id: n.id }, data: { status: "MENUNGGU_KONFIRMASI", duplicateOfId: null } });
    const { transaction } = await approveAndBook(n.id, actor, "Koreksi tanggal withdraw (audit 9 Nov)");
    out.changed.push(transaction.number);
    log(`    → ${t.number} dibatalkan, dicatat ulang ${transaction.number} tanggal ${wib(transaction.date)}`);
  }
  return out;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-tanggal-wd.ts")) {
  const apply = process.argv.includes("--jalankan");
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiTanggalWd(WD_TIKTOK, apply)
    .then((r) => {
      if (!apply && r.planned) console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
      if (!r.planned) console.log("\nTidak ada yang perlu diubah.");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
