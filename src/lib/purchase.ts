import type { PaymentTerm } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { locationSettings, recordMovement, StockError } from "./stock";

type Actor = { id: string; name: string };

export type PurchaseInput = {
  supplierId?: string | null;
  /** Supplier baru yang diketik di form pembelian; dibuat di master Supplier bila belum ada */
  newSupplierName?: string | null;
  vendor?: string | null;
  storeId: string;
  date: Date;
  term: PaymentTerm;
  /** `amount` = total harga baris; bila diisi, harga per satuan = amount ÷ qty */
  lines: { itemId: string; qty: number; unitCost?: number; amount?: number }[];
  /** Dibayar sekarang (LUNAS = total, BERTAHAP = DP, TEMPO = 0) */
  paidNow: number;
  bankAccountId?: string | null;
  dueDate?: Date | null;
  note?: string | null;
  proofPath?: string | null;
  proofMime?: string | null;
};

export const TERM_LABEL: Record<PaymentTerm, string> = { LUNAS: "Bayar di depan (lunas)", BERTAHAP: "Bertahap (DP + cicilan)", TEMPO: "Tempo (bayar nanti)" };

/** Status bayar dari tagihan vs nominal dibayar: sama = Lunas, kurang = Hutang (DP → Bertahap, 0 → Tempo) */
export function termFor(total: number, paid: number): PaymentTerm {
  if (paid < 0) throw new StockError("Nominal pembayaran tidak boleh minus");
  if (paid > total) throw new StockError("Nominal pembayaran melebihi tagihan");
  return paid === total ? "LUNAS" : paid > 0 ? "BERTAHAP" : "TEMPO";
}

/** Total baris pembelian: dari total harga baris bila ada, selain itu qty × harga satuan */
export function lineAmounts(lines: PurchaseInput["lines"]) {
  return lines.map((l) => {
    const amount = l.amount && l.amount > 0 ? Math.round(l.amount) : Math.round(l.qty * (l.unitCost ?? 0));
    const unitCost = l.amount && l.amount > 0 ? Math.round(l.amount / l.qty) : Math.round(l.unitCost ?? 0);
    return { ...l, amount, unitCost };
  });
}

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
  const lines = lineAmounts(input.lines.filter((l) => l.itemId && l.qty > 0));
  if (!lines.length) throw new StockError("Isi minimal satu item");
  if (lines.some((l) => !(l.amount > 0))) throw new StockError("Harga tiap item wajib diisi");
  const amounts = lines.map((l) => l.amount);
  const total = amounts.reduce((s, a) => s + a, 0);
  const { paid, debt } = splitPayment(input.term, total, input.paidNow);
  if (paid > 0 && !input.bankAccountId) throw new StockError("Pilih rekening pembayaran");
  if (debt > 0 && !input.dueDate) throw new StockError("Isi tanggal jatuh tempo untuk sisa pembayaran");
  return prisma.$transaction(async (tx) => {
    let supplier = input.supplierId ? await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId } }) : null;
    const newName = input.newSupplierName?.trim();
    if (!supplier && newName) {
      supplier = (await tx.supplier.findFirst({ where: { name: { equals: newName, mode: "insensitive" } } })) ?? (await tx.supplier.create({ data: { name: newName } }));
      await audit(actor, "SUPPLIER_DISIMPAN", "Supplier", supplier.id, { name: newName, from: "pembelian" }, tx);
    }
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
      // Harga beli terbaru untuk HPP realtime; harga sebelumnya disimpan untuk indikator naik/turun
      const it = await tx.item.findUniqueOrThrow({ where: { id: l.itemId } });
      if (!it.lastCostAt || input.date >= it.lastCostAt) await tx.item.update({ where: { id: l.itemId }, data: { prevCost: it.lastCost > BigInt(0) ? it.lastCost : BigInt(l.unitCost), lastCost: BigInt(l.unitCost), lastCostAt: input.date } });
    }
    const payable = debt > 0
      ? await tx.payable.create({ data: { number: await nextNumber(tx, "UTG", input.date), vendor, supplierId: supplier?.id ?? null, storeId: input.storeId, date: input.date, dueDate: input.dueDate ?? null, amount: BigInt(debt), note: `Sisa pembelian ${number}`, journalId: j.id } })
      : null;
    const p = await tx.purchase.create({
      data: {
        number, supplierId: supplier?.id ?? null, vendor, storeId: input.storeId, date: input.date, term: input.term, total: BigInt(total), paidNow: BigInt(paid),
        bankAccountId: bank?.id ?? null, payableId: payable?.id ?? null, journalId: j.id, note: input.note ?? null, proofPath: input.proofPath ?? null, proofMime: input.proofMime ?? null, createdBy: actor.name,
        lines: { create: lines.map((l, i) => ({ itemId: l.itemId, qty: l.qty, unitCost: BigInt(l.unitCost), amount: BigInt(amounts[i]) })) },
      },
    });
    await audit(actor, "PEMBELIAN_DIBUAT", "Purchase", p.id, { number, total, paid, debt, term: input.term }, tx);
    return p;
  });
}
