import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { COA, postJournal, type LineInput } from "./accounting";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/**
 * Bayar/angsur utang (utang supplier atau pinjaman modal) dari rekening: Dr Utang (+ bunga) / Cr Kas-Bank.
 * Dipakai halaman Akuntansi › Piutang, utang & pinjaman dan bot Telegram.
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
    const liability = doc.kind === "PINJAMAN" ? COA.UTANG_PINJAMAN : COA.UTANG_USAHA;
    const lines: LineInput[] = [{ accountCode: liability, debit: amount }, ...(interest > 0 ? [{ accountCode: COA.BEBAN_LAIN, debit: interest, memo: "Bunga / biaya pinjaman" }] : []), { accountId: bank.coaAccountId, credit: amount + interest }];
    const j = await postJournal(tx, { date: input.date, storeId: doc.storeId, description: `${liability === COA.UTANG_PINJAMAN ? "Cicilan pinjaman" : "Pembayaran utang"} ${doc.number}`, source: "UTANG", sourceId: doc.number, actor, lines });
    const updated = await tx.payable.update({ where: { id: doc.id }, data: { paid: { increment: BigInt(amount) } } });
    return { payable: updated, journal: j, remaining: remaining - amount };
  };
  return db ? run(db) : prisma.$transaction(run);
}

/** Utang yang belum lunas, terbaru dulu, beserta nama barang pembeliannya (untuk dicocokkan dengan pesan bot) */
export async function openPayables() {
  const rows = await prisma.payable.findMany({ where: {}, include: { supplier: { select: { name: true } } }, orderBy: { date: "desc" }, take: 200 });
  const open = rows.filter((p) => p.paid < p.amount);
  const purchases = await prisma.purchase.findMany({ where: { payableId: { in: open.map((p) => p.id) } }, select: { payableId: true, number: true, lines: { select: { item: { select: { name: true } } } } } });
  return open.map((p) => {
    const pu = purchases.find((x) => x.payableId === p.id);
    return { id: p.id, number: p.number, kind: p.kind, vendor: p.supplier?.name ?? p.vendor, remaining: Number(p.amount - p.paid), purchaseNumber: pu?.number ?? null, items: pu?.lines.map((l) => l.item.name) ?? [], note: p.note };
  });
}
export type OpenPayable = Awaited<ReturnType<typeof openPayables>>[number];
