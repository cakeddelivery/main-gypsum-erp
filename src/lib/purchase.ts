import type { PaymentTerm } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { locationSettings, recordMovement, StockError } from "./stock";

type Actor = { id: string; name: string };

export type PurchaseInput = {
  supplierId?: string | null;
  vendor?: string | null;
  storeId: string;
  date: Date;
  term: PaymentTerm;
  lines: { itemId: string; qty: number; unitCost: number }[];
  /** Dibayar sekarang (LUNAS = total, BERTAHAP = DP, TEMPO = 0) */
  paidNow: number;
  bankAccountId?: string | null;
  dueDate?: Date | null;
  note?: string | null;
};

export const TERM_LABEL: Record<PaymentTerm, string> = { LUNAS: "Bayar di depan (lunas)", BERTAHAP: "Bertahap (DP + cicilan)", TEMPO: "Tempo (bayar nanti)" };

/** Validasi murni cara bayar pembelian; mengembalikan nominal dibayar sekarang & sisa utang */
export function splitPayment(term: PaymentTerm, total: number, paidNow: number) {
  if (total <= 0) throw new StockError("Total pembelian harus > 0");
  if (term === "LUNAS") return { paid: total, debt: 0 };
  if (term === "TEMPO") {
    if (paidNow !== 0) throw new StockError("Tempo: tidak ada pembayaran di muka (pilih Bertahap bila ada DP)");
    return { paid: 0, debt: total };
  }
  if (!(paidNow > 0 && paidNow < total)) throw new StockError("Bertahap: DP harus lebih dari 0 dan kurang dari total");
  return { paid: paidNow, debt: total - paidNow };
}

/**
 * Pembelian bahan baku: stok masuk gudang bahan baku (harga rata-rata ikut diperbarui),
 * jurnal Dr Persediaan Bahan Baku / Cr Rekening (dibayar) + Cr Utang Usaha (sisa), sisa tercatat di Utang dengan jatuh tempo.
 */
export async function createPurchase(input: PurchaseInput, actor: Actor) {
  const lines = input.lines.filter((l) => l.itemId && l.qty > 0);
  if (!lines.length) throw new StockError("Isi minimal satu item");
  if (lines.some((l) => !(l.unitCost > 0))) throw new StockError("Harga satuan wajib diisi");
  const amounts = lines.map((l) => Math.round(l.qty * l.unitCost));
  const total = amounts.reduce((s, a) => s + a, 0);
  const { paid, debt } = splitPayment(input.term, total, input.paidNow);
  if (paid > 0 && !input.bankAccountId) throw new StockError("Pilih rekening pembayaran");
  if (debt > 0 && !input.dueDate) throw new StockError("Isi tanggal jatuh tempo untuk sisa pembayaran");
  return prisma.$transaction(async (tx) => {
    const supplier = input.supplierId ? await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId } }) : null;
    const vendor = input.vendor || supplier?.name;
    if (!vendor) throw new StockError("Supplier wajib diisi");
    const { raw } = await locationSettings(tx);
    if (!raw) throw new StockError("Lokasi gudang bahan baku belum diatur di Pengaturan");
    const number = await nextNumber(tx, "PBL", input.date);
    const bank = paid > 0 ? await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId! } }) : null;
    const jl: LineInput[] = [{ accountCode: COA.PERSEDIAAN_BAHAN, debit: total }];
    if (bank) jl.push({ accountId: bank.coaAccountId, credit: paid, memo: input.term === "LUNAS" ? "Lunas" : "DP" });
    if (debt > 0) jl.push({ accountCode: COA.UTANG_USAHA, credit: debt, memo: "Sisa pembelian" });
    const j = await postJournal(tx, { date: input.date, storeId: input.storeId, description: `Pembelian ${number} ${vendor}`, source: "PEMBELIAN", sourceId: number, actor, lines: jl });
    for (const l of lines) {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: l.itemId, qty: l.qty, toLocationId: raw, unitCost: l.unitCost, ref: number, note: `Pembelian ${vendor}`, date: input.date }, actor);
    }
    const payable = debt > 0
      ? await tx.payable.create({ data: { number: await nextNumber(tx, "UTG", input.date), vendor, supplierId: supplier?.id ?? null, storeId: input.storeId, date: input.date, dueDate: input.dueDate ?? null, amount: BigInt(debt), note: `Sisa pembelian ${number}`, journalId: j.id } })
      : null;
    const p = await tx.purchase.create({
      data: {
        number, supplierId: supplier?.id ?? null, vendor, storeId: input.storeId, date: input.date, term: input.term, total: BigInt(total), paidNow: BigInt(paid),
        bankAccountId: bank?.id ?? null, payableId: payable?.id ?? null, journalId: j.id, note: input.note ?? null, createdBy: actor.name,
        lines: { create: lines.map((l, i) => ({ itemId: l.itemId, qty: l.qty, unitCost: BigInt(l.unitCost), amount: BigInt(amounts[i]) })) },
      },
    });
    await audit(actor, "PEMBELIAN_DIBUAT", "Purchase", p.id, { number, total, paid, debt, term: input.term }, tx);
    return p;
  });
}
