/*
 * Catat transaksi Seabank 5984 yang terlewat/dobel hasil pencocokan mutasi SeaBank 1–9 Nov 2026 (audit 9 Nov).
 * Aman diulang: tiap langkah dikenali dari kuncinya, yang sudah dicatat dilewati.
 *
 *   npm run koreksi:saldo-5984                 -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:saldo-5984 -- --jalankan   -> menyimpan
 *
 * Jalankan SESUDAH koreksi:tanggal-wd. Langkah:
 *   1. Bunga tabungan 6, 7, 8, 9 Nov (Rp68 + Rp117 + Rp99 + Rp65) dicatat (Pendapatan Lain).
 *   2. TRX-202611-0056 bunga 1 Nov Rp504 dibatalkan: sudah termasuk di saldo awal Rp7.359.959 (diambil 01:55,
 *      bunga masuk 01:48).
 *   3. 2 Nov: pembayaran Shopee Rp22.800 (06:41) dan uang masuk dari ShopeePay Rp21.800 (09:06) dicatat.
 *   4. 3 Nov 09:00: transfer Rp300.000 5984 → 0006 "Nabung Spinjam 3 Nov" (setoran 3 Nov terkirim dua kali, yang
 *      kedua 4 Nov 05:18). Kelebihannya = sisihan Nabung Bayar Hutang tanggal 9 Nov (keputusan owner), jadi
 *      dicatat sebagai transfer dana sisihan untuk 9 Nov; sisihan 9 Nov tidak dicatat/ditransfer lagi.
 *   5. Saldo awal Seabank 0006 dikurangi Rp300.000: saldo aplikasi 9 Nov Rp2.000.009 sudah termasuk 9 kali setoran,
 *      jadi sisa 0006 sesudah bayar SPinjam & Mas Rizal = Rp1.600.009, bukan Rp1.900.009 (lawan Ekuitas Saldo Awal).
 * Hasil: saldo buku 5984 per 9 Nov 07:13 = Rp948.654 dan 0006 tetap = saldo aplikasi SeaBank.
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen, COA, postJournal } from "../src/lib/accounting";
import { approveAndBook, bookReserveTransfer, cancelBookedTransaction, createTransaction, type TxInput } from "../src/lib/finance";

export const BUNGA = [
  { at: "2026-11-06T01:38", amount: 68 },
  { at: "2026-11-07T01:50", amount: 117 },
  { at: "2026-11-08T01:40", amount: 99 },
  { at: "2026-11-09T01:39", amount: 65 },
];
export const BUNGA_DOBEL = { number: "TRX-202611-0056", amount: 504 };
export const NABUNG = { key: "NABUNG-DOBEL-5984-2026-11-03", at: "2026-11-03T09:00", amount: 300_000, forDate: "2026-11-09" };
export const ADJ_0006 = { sourceId: "AUDIT-SALDO-0006-2026-11-09-NABUNG", amount: 300_000, at: "2026-11-01T00:05" };
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(n).toLocaleString("id-ID");
const at = (s: string) => new Date(`${s}:00+07:00`);

export async function koreksiSaldo5984(apply: boolean, log: (s: string) => void = console.log, cfg = { bungaNumber: BUNGA_DOBEL.number }) {
  const [s5984, s0006] = await Promise.all([prisma.bankAccount.findUnique({ where: { code: "SEABANK" } }), prisma.bankAccount.findUnique({ where: { code: "SEABANK0006" } })]);
  if (!s5984 || !s0006) throw new Error("Rekening SEABANK (5984) / SEABANK0006 tidak ditemukan");
  const bal = async (coa: string, until?: Date) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: coa, ...(until ? { journal: { date: { lt: until } } } : {}) }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };
  const at0713 = at("2026-11-09T07:13");
  const before = { b5984: await bal(s5984.coaAccountId, at0713), k5984: await bal(s5984.coaAccountId), k0006: await bal(s0006.coaAccountId) };
  const [masuk, keluar] = await Promise.all([
    prisma.txCategory.findFirst({ where: { name: "Pendapatan Lain", direction: "MASUK" } }),
    prisma.txCategory.findFirst({ where: { name: "Beban Lain-lain", direction: "KELUAR" } }),
  ]);
  if (!masuk || !keluar) throw new Error('Kategori "Pendapatan Lain" / "Beban Lain-lain" tidak ditemukan');
  const fund = await prisma.reserveFund.findFirst({ where: { kind: "LOAN_SAVING", fromBankId: s5984.id, toBankId: s0006.id }, orderBy: { createdAt: "asc" } });
  if (!fund) throw new Error("Dana sisihan Nabung Bayar Hutang (5984 → 0006) tidak ditemukan");

  // Rencana: transaksi biasa yang belum dibukukan (dikenali dari kunci)
  type Plain = { key: string; input: TxInput; label: string };
  const plain: Plain[] = [
    ...BUNGA.map((b) => ({ key: `BUNGA-5984-${b.at.slice(0, 10)}`, label: `bunga tabungan ${b.at.replace("T", " ")} +${idr(b.amount)}`, input: { direction: "MASUK" as const, amount: b.amount, date: at(b.at), accountId: s5984.id, categoryId: masuk.id, counterparty: "Bunga Tabungan", note: `Bunga tabungan ${s5984.name}` } })),
    { key: "SHOPEE-5984-2026-11-02-KELUAR", label: "2 Nov 06:41 pembayaran Shopee −Rp22.800 (Beban Lain-lain)", input: { direction: "KELUAR", amount: 22_800, date: at("2026-11-02T06:41"), accountId: s5984.id, categoryId: keluar.id, counterparty: "Shopee", note: "Pembayaran Shopee (mutasi SeaBank 2 Nov)" } },
    { key: "SHOPEEPAY-5984-2026-11-02-MASUK", label: "2 Nov 09:06 uang masuk dari ShopeePay +Rp21.800 (Pendapatan Lain)", input: { direction: "MASUK", amount: 21_800, date: at("2026-11-02T09:06"), accountId: s5984.id, categoryId: masuk.id, counterparty: "ShopeePay", note: "Transfer masuk dari ShopeePay (mutasi SeaBank 2 Nov)" } },
  ];
  const todo: Plain[] = [];
  for (const p of plain) {
    const t = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: p.key } });
    if (t?.status === "DIBUKUKAN") log(`= sudah: ${p.label} (${t.number})`);
    else {
      todo.push(p);
      log(`+ ${p.label}`);
    }
  }

  const b56 = await prisma.financeTransaction.findUnique({ where: { number: cfg.bungaNumber } });
  if (!b56) throw new Error(`${cfg.bungaNumber} tidak ditemukan. Hentikan, kabari Claude.`);
  if (b56.direction !== "MASUK" || b56.accountId !== s5984.id || Number(b56.amount) !== BUNGA_DOBEL.amount) throw new Error(`${cfg.bungaNumber} bukan bunga 5984 ${idr(BUNGA_DOBEL.amount)}. Hentikan, kabari Claude.`);
  const cancelBunga = b56.status === "DIBUKUKAN";
  log(cancelBunga ? `- batalkan ${b56.number} bunga 1 Nov ${idr(BUNGA_DOBEL.amount)} (sudah termasuk saldo awal 7.359.959)` : `= ${b56.number} sudah ${b56.status}`);

  const nab = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: NABUNG.key } });
  const sisih9 = await prisma.reserveEntry.findFirst({ where: { fundId: fund.id, date: new Date(`${NABUNG.forDate}T00:00:00.000Z`), type: "SISIH" } });
  if (nab?.status === "DIBUKUKAN") log(`= sudah: transfer nabung dobel 3 Nov (${nab.number})`);
  else {
    if (sisih9?.transactionId && sisih9.transactionId !== nab?.id) throw new Error(`Sisihan ${fund.name} tanggal ${NABUNG.forDate} sudah memakai transfer lain. Hentikan, kabari Claude.`);
    log(`+ 3 Nov 09:00 transfer 5984 → 0006 ${idr(NABUNG.amount)} "Nabung Spinjam 3 Nov" (dobel) = sisihan ${fund.name} tanggal 9 Nov${sisih9 ? " (sisihan 9 Nov yang sudah tercatat tanpa bukti memakai transfer ini, jurnal lamanya dibalik)" : ""}`);
  }

  const adj = await prisma.journal.findFirst({ where: { source: "SALDO_AWAL", sourceId: ADJ_0006.sourceId } });
  if (adj) log(`= sudah: penyesuaian saldo awal 0006 (${adj.number})`);
  else log(`+ penyesuaian saldo awal ${s0006.name} −${idr(ADJ_0006.amount)} tanggal 1 Nov (sisa sesudah bayar SPinjam & Rizal Rp1.600.009, lawan Ekuitas Saldo Awal)`);

  const d5984 = todo.reduce((t, p) => t + (p.input.direction === "MASUK" ? 1 : -1) * p.input.amount, 0) - (cancelBunga ? BUNGA_DOBEL.amount : 0) - (nab?.status === "DIBUKUKAN" ? 0 : NABUNG.amount);
  const d0006 = (nab?.status === "DIBUKUKAN" ? 0 : NABUNG.amount) - (adj ? 0 : ADJ_0006.amount);
  log(`\nSaldo buku           sekarang  →  sesudah koreksi`);
  log(`  ${s5984.name} per 9 Nov 07:13: ${idr(before.b5984)} → ${idr(before.b5984 + d5984)}   (asli Rp948.654; jalankan koreksi:tanggal-wd dulu)`);
  log(`  ${s5984.name} kini:            ${idr(before.k5984)} → ${idr(before.k5984 + d5984)}`);
  log(`  ${s0006.name} kini:            ${idr(before.k0006)} → ${idr(before.k0006 + d0006)}`);
  log("Rekening lain tidak berubah.");
  const nothing = !todo.length && !cancelBunga && nab?.status === "DIBUKUKAN" && !!adj;
  if (nothing) return { hasil: "SUDAH" as const };
  if (!apply) return { hasil: "PRATINJAU" as const };

  for (const d of [at("2026-11-01T00:05"), at("2026-11-02T06:41"), at(NABUNG.at)]) await assertPeriodOpen(prisma, d);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip koreksi-saldo-5984" };
  const book = async (id: string, note: string) => {
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id } });
    if (t.status === "DIBUKUKAN") return t;
    if (t.status !== "MENUNGGU_KONFIRMASI") await prisma.financeTransaction.update({ where: { id }, data: { status: "MENUNGGU_KONFIRMASI", duplicateOfId: null } });
    return (await approveAndBook(id, actor, note)).transaction;
  };
  for (const p of todo) {
    const t = (await prisma.financeTransaction.findUnique({ where: { idempotencyKey: p.key } })) ?? (await createTransaction({ ...p.input, idempotencyKey: p.key }, "MANUAL", actor, { submit: true })).transaction;
    log(`    → ${(await book(t.id, "Koreksi audit saldo 9 Nov")).number} ${p.label}`);
  }
  if (cancelBunga) {
    const r = await cancelBookedTransaction(b56.id, actor, "Bunga 1 Nov sudah termasuk saldo awal 7.359.959 (audit 9 Nov)");
    log(`    → ${b56.number} dibatalkan, jurnal balik ${r.reversal.number}`);
  }
  if (nab?.status !== "DIBUKUKAN") {
    const r = nab
      ? { transaction: nab }
      : await bookReserveTransfer(
          { direction: "TRANSFER", amount: NABUNG.amount, date: at(NABUNG.at), accountId: s5984.id, toAccountId: s0006.id, counterparty: "Nur Aini Hidayah", note: "Nabung Spinjam 3 Nov 26 (transfer dobel, dipakai sebagai sisihan 9 Nov)", idempotencyKey: NABUNG.key },
          [{ fundId: fund.id, date: NABUNG.forDate, amount: NABUNG.amount }],
          "MANUAL",
          actor,
        );
    log(`    → ${(await book(r.transaction.id, "Transfer dana sisihan (nabung dobel 3 Nov = sisihan 9 Nov)")).number} transfer nabung 3 Nov = sisihan 9 Nov`);
  }
  if (!adj) {
    const j = await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: at(ADJ_0006.at),
        storeId: null,
        description: "Penyesuaian saldo awal Seabank 0006 (audit 9 Nov): sisa sesudah bayar SPinjam & Mas Rizal Rp1.600.009, bukan Rp1.900.009",
        source: "SALDO_AWAL",
        sourceId: ADJ_0006.sourceId,
        actor,
        lines: [
          { accountCode: COA.EKUITAS_SALDO_AWAL, debit: ADJ_0006.amount, memo: "Penyeimbang penyesuaian saldo 0006" },
          { accountId: s0006.coaAccountId, credit: ADJ_0006.amount, memo: "Saldo aplikasi 9 Nov 2.000.009 sudah termasuk 9 kali setoran nabung" },
        ],
      }),
    );
    log(`    → ${j.number} penyesuaian saldo awal 0006`);
  }
  log(`\n${s5984.name} kini ${idr(await bal(s5984.coaAccountId))} · per 9 Nov 07:13 ${idr(await bal(s5984.coaAccountId, at0713))} · ${s0006.name} kini ${idr(await bal(s0006.coaAccountId))}`);
  return { hasil: "DIKOREKSI" as const };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-saldo-5984.ts")) {
  const apply = process.argv.includes("--jalankan");
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiSaldo5984(apply)
    .then((r) => {
      if (r.hasil === "PRATINJAU") console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
      if (r.hasil === "SUDAH") console.log("\nSemua sudah dicatat. Tidak ada yang diubah.");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
