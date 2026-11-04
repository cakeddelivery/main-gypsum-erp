import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen, COA, postJournal, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Akun COA hutang: akun pilihan di hutang tsb, atau Hutang Usaha / Hutang Pinjaman Modal sesuai jenis */
export async function liabilityAccountId(db: Tx | typeof prisma, p: { kind: string; coaAccountId: string | null }) {
  if (p.coaAccountId) return p.coaAccountId;
  const a = await db.coaAccount.findUniqueOrThrow({ where: { code: p.kind === "PINJAMAN" ? COA.UTANG_PINJAMAN : COA.UTANG_USAHA } });
  return a.id;
}

type PlanInput = { amount: bigint | number; paid: bigint | number; installments: number | null; interestTotal: bigint | number | null };

/**
 * Cicilan berikutnya dari jadwal pinjaman (pokok & bunga dibagi rata, sisa pembulatan di cicilan terakhir).
 * null = hutang tanpa jadwal cicilan.
 */
export function nextInstallment(p: PlanInput): { no: number; principal: number; interest: number; total: number } | null {
  const n = p.installments ?? 0;
  if (n < 1) return null;
  const amount = Number(p.amount);
  const paid = Number(p.paid);
  const remaining = amount - paid;
  if (remaining <= 0) return null;
  const perP = Math.floor(amount / n);
  const interestTotal = Number(p.interestTotal ?? 0);
  const perI = Math.floor(interestTotal / n);
  const no = Math.min(n, Math.round(paid / perP) + 1);
  const principal = no === n ? remaining : Math.min(perP, remaining);
  const interest = no === n ? interestTotal - perI * (n - 1) : perI;
  return { no, principal, interest, total: principal + interest };
}

/**
 * Pecah nominal transfer menjadi pokok + bunga. Bila nominal = cicilan terjadwal, bunganya dari jadwal;
 * selain itu seluruhnya pokok (bunga bisa diisi manual).
 */
export function splitPayment(p: PlanInput, total: number, interest?: number | null): { principal: number; interest: number } {
  if (interest != null && interest > 0) return { principal: total - interest, interest };
  const next = nextInstallment(p);
  if (next && next.interest > 0 && Math.abs(total - next.total) <= 2) return { principal: total - next.interest, interest: next.interest };
  return { principal: total, interest: 0 };
}

/** Baris jurnal pembayaran hutang: Dr Hutang (pokok) + Dr Beban Bunga (bunga/biaya) / Cr rekening (total) */
export function payableLines(liabilityId: string, bankCoaId: string, principal: number, interest: number, memo: string): LineInput[] {
  return [
    { accountId: liabilityId, debit: principal, memo },
    ...(interest > 0 ? [{ accountCode: COA.BEBAN_BUNGA, debit: interest, memo: `Bunga / biaya ${memo}`.slice(0, 120) }] : []),
    { accountId: bankCoaId, credit: principal + interest, memo },
  ];
}

/**
 * Bayar/angsur hutang (supplier atau pinjaman modal) tanpa transaksi di menu Transaksi: Dr Hutang (+ bunga) / Cr Kas-Bank.
 * Halaman Akuntansi & bot memakai `bookPayablePayment` (finance.ts) agar pembayaran tampil di Transaksi.
 */
export async function payPayable(input: { payableId: string; amount: number; bankAccountId: string; date: Date; interest?: number }, actor: Actor, db?: Tx) {
  const run = async (tx: Tx) => {
    const doc = await tx.payable.findUniqueOrThrow({ where: { id: input.payableId } });
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } });
    const remaining = Number(doc.amount - doc.paid);
    const amount = input.amount;
    const interest = input.interest ?? 0;
    if (!(amount > 0) || amount > remaining) throw new Error(`Nominal harus 1 – ${remaining}`);
    if (interest < 0) throw new Error("Bunga tidak boleh negatif");
    const lines = payableLines(await liabilityAccountId(tx, doc), bank.coaAccountId, amount, interest, `${doc.number} ${doc.vendor}`.slice(0, 120));
    const j = await postJournal(tx, { date: input.date, storeId: doc.storeId, description: `${doc.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Pembayaran hutang"} ${doc.number}`, source: "UTANG", sourceId: doc.number, actor, lines });
    const updated = await tx.payable.update({ where: { id: doc.id }, data: { paid: { increment: BigInt(amount) } } });
    return { payable: updated, journal: j, remaining: remaining - amount };
  };
  return db ? run(db) : prisma.$transaction(run);
}

export type LoanInput = {
  lender: string;
  /** Pokok pinjaman (yang harus dikembalikan) */
  amount: number;
  date: Date;
  dueDate?: Date | null;
  note?: string | null;
  storeId?: string | null;
  /** Akun COA hutang; kosong = Hutang Pinjaman Modal */
  coaAccountId?: string | null;
  /** Rekening penerima. Kosong = pinjaman lama (diterima sebelum memakai aplikasi): lawannya Ekuitas Saldo Awal */
  bankAccountId?: string | null;
  /** Uang yang benar-benar diterima (pokok dikurangi biaya pencairan); selisihnya dicatat sebagai beban bunga & biaya pinjaman */
  received?: number | null;
  /** Pinjaman lama: pokok yang sudah dibayar sebelum memakai aplikasi */
  paidBefore?: number | null;
  installments?: number | null;
  interestTotal?: number | null;
};

/**
 * Catat pinjaman modal.
 * - Baru: Dr Rekening (diterima) + Dr Beban Bunga & Biaya Pinjaman (potongan pencairan) / Cr Hutang (pokok)
 * - Lama (sebelum memakai aplikasi): Dr Ekuitas Saldo Awal / Cr Hutang sebesar sisa pokok; pokok yang sudah dibayar dicatat sebagai terbayar
 */
export async function createLoanRecord(input: LoanInput, actor: Actor, db?: Tx) {
  const run = async (tx: Tx) => {
    const amount = Math.round(input.amount);
    if (!(amount > 0)) throw new Error("Nominal pinjaman harus > 0");
    const lender = input.lender.trim();
    if (lender.length < 2) throw new Error("Pemberi pinjaman wajib diisi");
    if (input.installments != null && (!Number.isInteger(input.installments) || input.installments < 1 || input.installments > 120)) throw new Error("Jumlah cicilan 1 – 120");
    if (input.interestTotal != null && input.interestTotal < 0) throw new Error("Total bunga tidak boleh negatif");
    const liabilityId = input.coaAccountId || (await liabilityAccountId(tx, { kind: "PINJAMAN", coaAccountId: null }));
    const liab = await tx.coaAccount.findUniqueOrThrow({ where: { id: liabilityId } });
    if (liab.type !== "KEWAJIBAN") throw new Error("Akun hutang harus akun kewajiban (2-xxxx)");
    const number = await nextNumber(tx, "PJM");
    let lines: LineInput[];
    let paid = 0;
    if (input.bankAccountId) {
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } });
      const received = input.received == null ? amount : Math.round(input.received);
      if (!(received > 0) || received > amount) throw new Error("Uang diterima harus 1 – nominal pinjaman");
      lines = [
        { accountId: bank.coaAccountId, debit: received, memo: `Pinjaman ${lender}` },
        ...(received < amount ? [{ accountCode: COA.BEBAN_BUNGA, debit: amount - received, memo: "Biaya pencairan pinjaman" }] : []),
        { accountId: liabilityId, credit: amount, memo: `Pinjaman ${lender}` },
      ];
    } else {
      paid = Math.round(input.paidBefore ?? 0);
      if (paid < 0 || paid >= amount) throw new Error("Pokok yang sudah dibayar harus 0 – kurang dari nominal pinjaman");
      lines = [
        { accountCode: COA.EKUITAS_SALDO_AWAL, debit: amount - paid, memo: `Saldo awal pinjaman ${lender}` },
        { accountId: liabilityId, credit: amount - paid, memo: `Sisa pinjaman ${lender} saat mulai memakai aplikasi` },
      ];
    }
    // Pinjaman lama yang tanggal terimanya di periode yang sudah ditutup: saldo awalnya dibukukan hari ini
    const jDate = input.bankAccountId ? input.date : await assertPeriodOpen(tx, input.date).then(() => input.date, () => new Date());
    const j = await postJournal(tx, { date: jDate, storeId: input.storeId ?? null, description: `Pinjaman modal ${number} ${lender}${input.bankAccountId ? "" : " (saldo awal)"}`, source: input.bankAccountId ? "PINJAMAN" : "SALDO_AWAL", sourceId: number, actor, lines });
    return tx.payable.create({
      data: { number, kind: "PINJAMAN", vendor: lender, storeId: j.storeId, date: input.date, dueDate: input.dueDate ?? null, amount: BigInt(amount), paid: BigInt(paid), note: input.note ?? null, journalId: j.id, coaAccountId: input.coaAccountId || null, installments: input.installments ?? null, interestTotal: input.interestTotal == null ? null : BigInt(Math.round(input.interestTotal)) },
    });
  };
  return db ? run(db) : prisma.$transaction(run);
}

/** Hutang yang belum lunas, terbaru dulu, beserta nama barang pembeliannya (untuk dicocokkan dengan pesan bot) */
export async function openPayables() {
  const rows = await prisma.payable.findMany({ where: {}, include: { supplier: { select: { name: true } } }, orderBy: { date: "desc" }, take: 200 });
  const open = rows.filter((p) => p.paid < p.amount);
  const purchases = await prisma.purchase.findMany({ where: { payableId: { in: open.map((p) => p.id) } }, select: { payableId: true, number: true, lines: { select: { item: { select: { name: true } } } } } });
  return open.map((p) => {
    const pu = purchases.find((x) => x.payableId === p.id);
    return { id: p.id, number: p.number, kind: p.kind, vendor: p.supplier?.name ?? p.vendor, remaining: Number(p.amount - p.paid), purchaseNumber: pu?.number ?? null, items: pu?.lines.map((l) => l.item.name) ?? [], note: p.note, installment: nextInstallment(p)?.total ?? null };
  });
}
export type OpenPayable = Awaited<ReturnType<typeof openPayables>>[number];
