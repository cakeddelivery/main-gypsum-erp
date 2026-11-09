/*
 * Koreksi saldo Seabank 5984 hasil pencocokan mutasi SeaBank 4–9 Nov 2026 (audit 9 Nov). Aman diulang.
 *
 *   npm run koreksi:saldo-5984                 -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:saldo-5984 -- --jalankan   -> menyimpan
 *
 * Sejak 4 Nov semua transaksi 5984 di ERP cocok dengan mutasi bank (sebagian hanya beda jam/tanggal, dibetulkan
 * oleh koreksi:tanggal-wd), kecuali:
 *   1. Bunga tabungan 6, 7, 8, 9 Nov (Rp68 + Rp117 + Rp99 + Rp65) belum dicatat → dicatat sebagai pemasukan
 *      "Pendapatan Lain".
 *   2. Saldo buku sebelum transaksi 4 Nov kelebihan Rp301.504:
 *        Rp240.000 dari "Atur saldo" 4 Nov (JU-202611-0005) yang memakai angka saldo 3 Nov, dan
 *        Rp61.504 selisih masa persiapan 1–3 Nov (dua kali atur saldo + koreksi PR #38).
 *      Saldo asli awal 4 Nov (dihitung mundur dari mutasi bank) = Rp1.691.001; transaksi bertanggal 3 Nov di ERP
 *      yang baru masuk/keluar bank 4 Nov pagi (WD 126.482 & 285.919, sisihan 3 Nov 500.000) ikut diperhitungkan.
 *      → jurnal penyesuaian saldo awal: 5984 −Rp301.504, lawan Ekuitas Saldo Awal, tanggal sama dengan JU-0005.
 * Hasil: saldo buku 5984 per 9 Nov 07:13 = Rp948.654 (saldo aplikasi SeaBank saat itu).
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen, COA, postJournal } from "../src/lib/accounting";
import { approveAndBook, createTransaction } from "../src/lib/finance";

export const ADJ_SOURCE_ID = "AUDIT-SALDO-5984-2026-11-09";
export const ADJ_AMOUNT = 301_504;
export const OPENING_BEFORE_4NOV = 1_664_906;
export const BUNGA = [
  { at: "2026-11-06T01:38", amount: 68 },
  { at: "2026-11-07T01:50", amount: 117 },
  { at: "2026-11-08T01:40", amount: 99 },
  { at: "2026-11-09T01:39", amount: 65 },
];
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(n).toLocaleString("id-ID");

export async function koreksiSaldo5984(apply: boolean, log: (s: string) => void = console.log, cfg = { adjNumber: "JU-202611-0005", opening: OPENING_BEFORE_4NOV }) {
  const bank = await prisma.bankAccount.findUnique({ where: { code: "SEABANK" } });
  if (!bank) throw new Error("Rekening SEABANK (5984) tidak ditemukan");
  const bal = async (until?: Date) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: bank.coaAccountId, ...(until ? { journal: { date: { lt: until } } } : {}) }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };
  const at0713 = new Date("2026-11-09T07:13:00+07:00");
  const before = { kini: await bal(), at0713: await bal(at0713) };

  // 1. Bunga
  const cat = await prisma.txCategory.findFirst({ where: { name: "Pendapatan Lain", direction: "MASUK" } });
  if (!cat) throw new Error('Kategori "Pendapatan Lain" tidak ditemukan');
  const bungaTodo: typeof BUNGA = [];
  for (const b of BUNGA) {
    const key = `BUNGA-5984-${b.at.slice(0, 10)}`;
    const t = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: key } });
    if (t?.status === "DIBUKUKAN") log(`= bunga ${b.at.slice(0, 10)} ${idr(b.amount)} sudah dicatat (${t.number})`);
    else {
      bungaTodo.push(b);
      log(`+ bunga tabungan ${b.at.replace("T", " ")} ${idr(b.amount)} (Pendapatan Lain)`);
    }
  }

  // 2. Penyesuaian saldo awal
  const done = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: ADJ_SOURCE_ID } });
  const adj = await prisma.journal.findUnique({ where: { number: cfg.adjNumber }, include: { lines: true } });
  if (done) log(`= penyesuaian saldo awal sudah dibukukan (${done.number})`);
  else {
    const adj5984 = adj?.lines.filter((l) => l.accountId === bank.coaAccountId).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
    if (!adj || adj.source !== "SALDO_AWAL" || adj5984 !== 240_000) throw new Error("JU-202611-0005 tidak sesuai hasil audit. Hentikan, kabari Claude.");
    const open = await bal(new Date("2026-11-04T00:00:00+07:00"));
    if (open !== cfg.opening) throw new Error(`Saldo buku 5984 sebelum 4 Nov ${idr(open)}, bukan ${idr(cfg.opening)} seperti saat audit. Hentikan, kabari Claude.`);
    await assertPeriodOpen(prisma, adj.date);
    log(`+ penyesuaian saldo awal 5984 −${idr(ADJ_AMOUNT)} tanggal ${adj.date.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16)} (lawan Ekuitas Saldo Awal)`);
  }
  const plus = bungaTodo.reduce((a, b) => a + b.amount, 0) - (done ? 0 : ADJ_AMOUNT);
  log(`\n${bank.name}            sekarang  →  sesudah koreksi`);
  log(`  per 9 Nov 07:13: ${idr(before.at0713)} → ${idr(before.at0713 + plus)}   (asli Rp948.654; jalankan koreksi:tanggal-wd dulu)`);
  log(`  saldo kini:      ${idr(before.kini)} → ${idr(before.kini + plus)}`);
  log("Rekening lain tidak berubah.");
  if (!apply || (!bungaTodo.length && done)) return { hasil: !bungaTodo.length && done ? "SUDAH" : "PRATINJAU", plus };

  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip koreksi-saldo-5984" };
  for (const b of bungaTodo) {
    const key = `BUNGA-5984-${b.at.slice(0, 10)}`;
    const t =
      (await prisma.financeTransaction.findUnique({ where: { idempotencyKey: key } })) ??
      (await createTransaction({ direction: "MASUK", amount: b.amount, date: new Date(`${b.at}:00+07:00`), accountId: bank.id, categoryId: cat.id, counterparty: "Bunga Tabungan", note: `Bunga tabungan ${bank.name}`, idempotencyKey: key }, "MANUAL", actor, { submit: true })).transaction;
    if (t.status !== "MENUNGGU_KONFIRMASI") await prisma.financeTransaction.update({ where: { id: t.id }, data: { status: "MENUNGGU_KONFIRMASI", duplicateOfId: null } });
    const r = await approveAndBook(t.id, actor, "Bunga tabungan (audit saldo 9 Nov)");
    log(`    → ${r.transaction.number} bunga ${idr(b.amount)} dibukukan`);
  }
  if (!done) {
    const j = await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: adj!.date,
        storeId: null,
        description: "Penyesuaian saldo Seabank 5984 (audit 9 Nov): Atur saldo 4 Nov memakai angka 3 Nov (240.000) + selisih masa persiapan 1–3 Nov (61.504)",
        source: "SALDO_AWAL",
        sourceId: ADJ_SOURCE_ID,
        actor,
        lines: [
          { accountCode: COA.EKUITAS_SALDO_AWAL, debit: ADJ_AMOUNT, memo: "Penyeimbang penyesuaian saldo 5984" },
          { accountId: bank.coaAccountId, credit: ADJ_AMOUNT, memo: "Saldo asli awal 4 Nov Rp1.691.001 (mutasi bank)" },
        ],
      }),
    );
    log(`    → ${j.number} penyesuaian saldo awal dibukukan`);
  }
  log(`\nSaldo 5984 kini ${idr(await bal())}`);
  return { hasil: "DIKOREKSI", plus };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-saldo-5984.ts")) {
  const apply = process.argv.includes("--jalankan");
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiSaldo5984(apply)
    .then((r) => {
      if (r.hasil === "PRATINJAU") console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
