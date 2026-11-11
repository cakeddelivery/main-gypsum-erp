import { Prisma, type PaymentTerm } from "@prisma/client";
import { prisma } from "./db";
import { resolveSupplier } from "./suppliers";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
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
  lines: { itemId: string; qty: number; unitCost?: number; amount?: number; receiptId?: string | null }[];
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

/** Validasi murni cara bayar pembelian; mengembalikan nominal dibayar sekarang & sisa hutang */
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
 * jurnal Dr Persediaan Bahan Baku / Cr Rekening (dibayar) + Cr Hutang Usaha (sisa), sisa tercatat di Hutang dengan jatuh tempo.
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
    // Nama supplier yang diketik dicocokkan dengan master (termasuk nama lain) agar tidak dobel dengan menu Hutang
    const supplier = await resolveSupplier(tx, { supplierId: input.supplierId, name: input.newSupplierName || input.vendor }, actor, "pembelian");
    const vendor = supplier?.name || input.vendor;
    if (!vendor) throw new StockError("Supplier wajib diisi");
    const { raw } = await locationSettings(tx);
    if (!raw) throw new StockError("Lokasi gudang bahan baku belum diatur di Pengaturan");
    const number = await nextNumber(tx, "PBL", input.date);
    const bank = paid > 0 ? await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId! } }) : null;
    // Barang masuk dari laporan shift: fisiknya sudah dihitung di stok akhir shift, jadi stok masuk bertanggal waktu barang masuk
    const receiptIds = lines.map((l) => l.receiptId).filter((x): x is string => !!x);
    if (new Set(receiptIds).size !== receiptIds.length) throw new StockError("Satu barang masuk hanya bisa ditautkan sekali");
    if (receiptIds.length) await tx.$queryRaw`SELECT id FROM "ShiftReceipt" WHERE id IN (${Prisma.join(receiptIds)}) FOR UPDATE`;
    const receipts = receiptIds.length ? await tx.shiftReceipt.findMany({ where: { id: { in: receiptIds } }, include: { item: true } }) : [];
    for (const l of lines) {
      if (!l.receiptId) continue;
      const x = receipts.find((r) => r.id === l.receiptId);
      if (!x) throw new StockError("Barang masuk tidak ditemukan");
      if (x.purchaseId) throw new StockError(`${x.number} sudah ditautkan ke pembelian lain`);
      if (x.itemId !== l.itemId) throw new StockError(`${x.number}: barang harus sama dengan barang masuk (${x.item.name})`);
      if (Math.abs(Number(x.qty) - l.qty) > 0.0005) throw new StockError(`${x.number}: jumlah harus sama dengan barang masuk (${Number(x.qty).toLocaleString("id-ID")} ${x.item.unit}). Selisih nota dicatat di baris terpisah.`);
    }
    const jl: LineInput[] = [{ accountCode: COA.PERSEDIAAN_BAHAN, debit: total }];
    if (bank) jl.push({ accountId: bank.coaAccountId, credit: paid, memo: input.term === "LUNAS" ? "Lunas" : "DP" });
    if (debt > 0) jl.push({ accountCode: COA.UTANG_USAHA, credit: debt, memo: "Sisa pembelian" });
    const j = await postJournal(tx, { date: input.date, storeId: input.storeId, description: `Pembelian ${number} ${vendor}`, source: "PEMBELIAN", sourceId: number, actor, lines: jl });
    for (const l of lines) {
      const rc = l.receiptId ? receipts.find((r) => r.id === l.receiptId) : null;
      await recordMovement(tx, { type: "PENERIMAAN", itemId: l.itemId, qty: l.qty, toLocationId: raw, unitCost: l.unitCost, ref: number, note: rc ? `Pembelian ${vendor} (barang masuk ${rc.number})` : `Pembelian ${vendor}`, date: rc ? rc.receivedAt : input.date }, actor);
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
    if (receiptIds.length) await tx.shiftReceipt.updateMany({ where: { id: { in: receiptIds } }, data: { purchaseId: p.id } });
    await audit(actor, "PEMBELIAN_DIBUAT", "Purchase", p.id, { number, total, paid, debt, term: input.term, receipts: receipts.map((r) => r.number) }, tx);
    return p;
  });
}

/**
 * Batalkan pembelian: jurnal dibalik, bahan baku dikeluarkan lagi dari gudang, hutang sisanya dihapus.
 * Ditolak bila hutangnya sudah pernah dicicil (batalkan pembayaran hutangnya di menu Transaksi dulu).
 * Tanggal pembalik = tanggal pembelian bila periodenya masih terbuka, selain itu hari ini.
 */
export async function cancelPurchase(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${id} FOR UPDATE`;
    const p = await tx.purchase.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (p.cancelledAt) throw new StockError(`${p.number} sudah dibatalkan`);
    const payable = p.payableId ? await tx.payable.findUnique({ where: { id: p.payableId } }) : null;
    if (payable && payable.paid > BigInt(0)) throw new StockError(`Hutang ${payable.number} sudah dicicil Rp ${Number(payable.paid).toLocaleString("id-ID")}. Batalkan pembayaran hutangnya dulu di menu Transaksi.`);
    const date = await assertPeriodOpen(tx, p.date).then(() => p.date, () => now);
    if (p.journalId) await reverseJournal(tx, p.journalId, date, actor, `batal ${p.number} — ${reason.trim()}`.slice(0, 150));
    const { raw } = await locationSettings(tx);
    for (const l of p.lines) {
      const from = (await tx.stockMovement.findFirst({ where: { ref: p.number, itemId: l.itemId, type: "PENERIMAAN" } }))?.toLocationId ?? raw;
      if (!from) throw new StockError("Lokasi gudang bahan baku belum diatur di Pengaturan");
      await recordMovement(tx, { type: "PENGELUARAN", itemId: l.itemId, qty: Number(l.qty), fromLocationId: from, ref: `BATAL ${p.number}`, note: `Pembatalan ${p.number}`, date, allowNegative: true, noJournal: true }, actor);
    }
    if (payable) {
      await tx.financeTransaction.updateMany({ where: { payableId: payable.id, status: { not: "DIBUKUKAN" } }, data: { payableId: null } });
      await tx.purchase.update({ where: { id }, data: { payableId: null } });
      await tx.payable.delete({ where: { id: payable.id } });
    }
    // Barang masuk laporan shift yang tertaut kembali "belum ditautkan" (fisiknya tetap ada, perlu pembelian pengganti)
    await tx.shiftReceipt.updateMany({ where: { purchaseId: id }, data: { purchaseId: null } });
    const out = await tx.purchase.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await audit(actor, "PEMBELIAN_DIBATALKAN", "Purchase", id, { number: p.number, reason }, tx);
    return out;
  });
}
