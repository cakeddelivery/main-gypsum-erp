import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen, postJournal, reverseJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { autoCode } from "./codes";
import { audit } from "./audit";
import { locationSettings, qtyAt, recordMovement, StockError } from "./stock";
import { recipeMaterialCost } from "./hpp";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Sumber jurnal penjualan & cicilan piutang penjualan (tampil di Mutasi rekening) */
export const SALE_SOURCE = "PENJUALAN";
export const WALK_IN = "Pelanggan umum";

export type SaleLineInput = { itemId: string; qty: number; price: number };

export type SaleInput = {
  date: Date;
  storeId: string;
  customerId?: string | null;
  /** Pelanggan baru yang diketik di form; otomatis masuk menu Pelanggan */
  newCustomerName?: string | null;
  newCustomerPhone?: string | null;
  lines: SaleLineInput[];
  /** Diskon per nota (Rp) */
  discount?: number;
  /** Ongkir yang ditagih ke pembeli (Rp) */
  shipping?: number;
  /** Dibayar sekarang (0 = tempo) */
  paidNow: number;
  bankAccountId?: string | null;
  dueDate?: Date | null;
  note?: string | null;
  proofPath?: string | null;
  proofMime?: string | null;
};

export type PaymentInput = { amount: number; bankAccountId: string; date: Date; note?: string | null; proofPath?: string | null; proofMime?: string | null };

/** Hitungan nota (murni, dipakai juga oleh form & unit test): subtotal, diskon, ongkir, tagihan, sisa */
export function saleTotals(lines: SaleLineInput[], discount = 0, shipping = 0, paid = 0) {
  const rows = lines.filter((l) => l.itemId && l.qty > 0).map((l) => ({ ...l, amount: Math.round(l.qty * l.price) }));
  if (rows.some((l) => !(l.price >= 0) || !Number.isFinite(l.price))) throw new StockError("Harga tidak boleh minus");
  const subtotal = rows.reduce((s, l) => s + l.amount, 0);
  const disc = Math.round(discount || 0);
  const ship = Math.round(shipping || 0);
  if (disc < 0 || ship < 0) throw new StockError("Diskon dan ongkir tidak boleh minus");
  if (disc > subtotal) throw new StockError("Diskon melebihi jumlah harga barang");
  const total = subtotal - disc + ship;
  if (paid < 0) throw new StockError("Nominal pembayaran tidak boleh minus");
  if (paid > total) throw new StockError("Nominal pembayaran melebihi tagihan");
  return { rows, subtotal, discount: disc, shipping: ship, total, paid, debt: total - paid };
}

/** Status bayar penjualan */
export function saleStatus(s: { total: bigint | number; paid: bigint | number; cancelledAt?: Date | null; dueDate?: Date | null }, now = new Date()) {
  if (s.cancelledAt) return { key: "BATAL", label: "Dibatalkan", tone: "gray" as const };
  const rest = Number(s.total) - Number(s.paid);
  if (rest <= 0) return { key: "LUNAS", label: "Lunas", tone: "green" as const };
  if (s.dueDate && s.dueDate < now) return { key: "JATUH_TEMPO", label: "Lewat jatuh tempo", tone: "red" as const };
  return { key: Number(s.paid) > 0 ? "SEBAGIAN" : "TEMPO", label: Number(s.paid) > 0 ? "Bayar sebagian" : "Tempo", tone: "amber" as const };
}

/** Pelanggan dari pilihan / nama baru (dicocokkan dulu dengan master agar tidak dobel) */
async function resolveCustomer(tx: Tx, input: SaleInput, actor: Actor) {
  if (input.customerId) return tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
  const name = input.newCustomerName?.trim().replace(/\s+/g, " ");
  if (!name) return null;
  const same = await tx.customer.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (same) return same;
  const c = await tx.customer.create({ data: { code: await autoCode.customer(tx), name, phone: input.newCustomerPhone?.trim() || null } });
  await audit(actor, "PELANGGAN_DIBUAT", "Customer", c.id, { name, from: "penjualan" }, tx);
  return c;
}

/**
 * Catat penjualan offline:
 * - Jurnal: Dr Rekening (dibayar) + Dr Piutang (sisa) / Cr Penjualan (harga − diskon) + Cr Pendapatan Ongkir
 * - Stok barang jadi keluar dari gudang barang jadi → Dr HPP / Cr Persediaan Barang Jadi (lewat recordMovement).
 *   Stok boleh minus (produksi belum diinput); peringatannya dikembalikan & tampil di tab stok minus.
 *   Opname akhir bulan hanya menghitung selisih sisanya, jadi HPP tidak ganda.
 * - Sisa tagihan tercatat sebagai Piutang (terhubung ke penjualan) dengan jatuh tempo.
 */
export async function createSale(input: SaleInput, actor: Actor) {
  const t = saleTotals(input.lines, input.discount, input.shipping, input.paidNow);
  if (!t.rows.length) throw new StockError("Isi minimal satu barang");
  if (!(t.total > 0)) throw new StockError("Total penjualan harus lebih dari 0");
  if (t.paid > 0 && !input.bankAccountId) throw new StockError("Pilih rekening penerima pembayaran");
  if (t.debt > 0 && !input.dueDate) throw new StockError("Isi tanggal jatuh tempo untuk sisa pembayaran");
  if (t.debt > 0 && !input.customerId && !input.newCustomerName?.trim()) throw new StockError("Penjualan tempo / bayar sebagian wajib memilih pelanggan");
  return prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, input.date);
    const customer = await resolveCustomer(tx, input, actor);
    const customerName = customer?.name ?? WALK_IN;
    const { finished } = await locationSettings(tx);
    if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
    const items = await tx.item.findMany({ where: { id: { in: t.rows.map((l) => l.itemId) } } });
    for (const l of t.rows) {
      const it = items.find((i) => i.id === l.itemId);
      if (!it) throw new StockError("Barang tidak ditemukan");
      if (it.type !== "BARANG_JADI") throw new StockError(`${it.name} bukan produk jadi`);
    }
    const number = await nextNumber(tx, "JUAL", input.date);
    const bank = t.paid > 0 ? await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId! } }) : null;
    const revenue = t.subtotal - t.discount;
    const memo = `${number} ${customerName}`.slice(0, 120);
    const jl: LineInput[] = [];
    if (bank) jl.push({ accountId: bank.coaAccountId, debit: t.paid, memo: t.debt ? "Bayar sebagian" : "Lunas" });
    if (t.debt > 0) jl.push({ accountCode: COA.PIUTANG, debit: t.debt, memo: "Sisa tagihan penjualan" });
    if (revenue > 0) jl.push({ accountCode: COA.PENJUALAN, credit: revenue, memo: t.discount ? `Penjualan (diskon ${t.discount.toLocaleString("id-ID")})` : "Penjualan" });
    if (t.shipping > 0) jl.push({ accountCode: COA.PENDAPATAN_ONGKIR, credit: t.shipping, memo: "Ongkir ditagih ke pembeli" });
    const j = await postJournal(tx, { date: input.date, storeId: input.storeId, description: `Penjualan ${memo}`, source: SALE_SOURCE, sourceId: number, actor, lines: jl });

    const sale = await tx.sale.create({
      data: {
        number, date: input.date, storeId: input.storeId, customerId: customer?.id ?? null, customerName,
        subtotal: BigInt(t.subtotal), discount: BigInt(t.discount), shipping: BigInt(t.shipping), total: BigInt(t.total), paid: BigInt(t.paid),
        dueDate: t.debt > 0 ? input.dueDate ?? null : null, journalId: j.id, note: input.note?.trim() || null, createdBy: actor.name,
      },
    });
    let hpp = 0;
    const warnings: string[] = [];
    for (const l of t.rows) {
      const it = items.find((i) => i.id === l.itemId)!;
      // Harga pokok rata-rata masih 0 (produksi belum diinput): cadangan dari resep produk, agar HPP tidak Rp0
      const fallbackUnitCost = Number(it.avgCost) > 0 ? null : { value: await recipeMaterialCost(l.itemId), note: "harga pokok dari resep" };
      const mv = await recordMovement(tx, { type: "PENGELUARAN", itemId: l.itemId, qty: l.qty, fromLocationId: finished, ref: number, note: `Penjualan ${customerName}`, date: input.date, allowNegative: true, fallbackUnitCost }, actor);
      const unitCost = Number(mv.unitCost);
      hpp += Math.round(l.qty * unitCost);
      await tx.saleLine.create({ data: { saleId: sale.id, itemId: l.itemId, qty: l.qty, price: BigInt(Math.round(l.price)), amount: BigInt(l.amount), unitCost: BigInt(unitCost) } });
      const left = await qtyAt(tx, l.itemId, finished);
      if (left < 0) warnings.push(`Stok ${it.name} sekarang ${left.toLocaleString("id-ID")} (minus). Cek hasil produksi yang belum diinput`);
    }
    if (bank) await tx.salePayment.create({ data: { saleId: sale.id, date: input.date, amount: BigInt(t.paid), bankAccountId: bank.id, initial: true, journalId: j.id, proofPath: input.proofPath ?? null, proofMime: input.proofMime ?? null, createdBy: actor.name } });
    if (t.debt > 0) {
      await tx.receivable.create({ data: { number: await nextNumber(tx, "PIU", input.date), saleId: sale.id, customer: customerName, storeId: input.storeId, date: input.date, dueDate: input.dueDate ?? null, amount: BigInt(t.debt), note: `Sisa penjualan ${number}`, journalId: j.id } });
    }
    const out = await tx.sale.update({ where: { id: sale.id }, data: { hpp: BigInt(hpp) } });
    await audit(actor, "PENJUALAN_DIBUAT", "Sale", sale.id, { number, total: t.total, paid: t.paid, debt: t.debt, hpp }, tx);
    return { sale: out, warnings };
  });
}

/** Terima cicilan / pelunasan piutang penjualan: Dr Rekening / Cr Piutang */
export async function paySale(saleId: string, p: PaymentInput, actor: Actor) {
  const amount = Math.round(p.amount);
  if (!(amount > 0)) throw new StockError("Nominal pembayaran harus lebih dari 0");
  if (!p.bankAccountId) throw new StockError("Pilih rekening penerima");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const s = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { receivable: true } });
    if (s.cancelledAt) throw new StockError(`${s.number} sudah dibatalkan`);
    const rest = Number(s.total - s.paid);
    if (rest <= 0) throw new StockError(`${s.number} sudah lunas`);
    if (amount > rest) throw new StockError(`Nominal melebihi sisa tagihan (${rest.toLocaleString("id-ID")})`);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: p.bankAccountId } });
    const lunas = amount === rest;
    const j = await postJournal(tx, {
      date: p.date, storeId: s.storeId, description: `${lunas ? "Pelunasan" : "Cicilan"} piutang ${s.number} ${s.customerName}`.slice(0, 150), source: SALE_SOURCE, sourceId: s.number, actor,
      lines: [{ accountId: bank.coaAccountId, debit: amount }, { accountCode: COA.PIUTANG, credit: amount }],
    });
    const pay = await tx.salePayment.create({ data: { saleId, date: p.date, amount: BigInt(amount), bankAccountId: bank.id, journalId: j.id, note: p.note?.trim() || null, proofPath: p.proofPath ?? null, proofMime: p.proofMime ?? null, createdBy: actor.name } });
    await tx.sale.update({ where: { id: saleId }, data: { paid: { increment: BigInt(amount) } } });
    if (s.receivable) await tx.receivable.update({ where: { id: s.receivable.id }, data: { paid: { increment: BigInt(amount) } } });
    await audit(actor, "PENJUALAN_DIBAYAR", "Sale", saleId, { number: s.number, amount, lunas }, tx);
    return { payment: pay, sale: s, lunas, rest: rest - amount };
  });
}

/** Tanggal jurnal pembalik: tanggal asli bila periodenya masih terbuka, selain itu hari ini */
const reverseDate = (tx: Tx, date: Date, now: Date) => assertPeriodOpen(tx, date).then(() => date, () => now);

/** Batalkan satu cicilan yang salah input: jurnalnya dibalik, sisa piutang kembali */
export async function cancelSalePayment(paymentId: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const p0 = await tx.salePayment.findUniqueOrThrow({ where: { id: paymentId } });
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${p0.saleId} FOR UPDATE`;
    const p = await tx.salePayment.findUniqueOrThrow({ where: { id: paymentId }, include: { sale: { include: { receivable: true } } } });
    if (p.cancelledAt) throw new StockError("Pembayaran ini sudah dibatalkan");
    if (p.initial) throw new StockError("Pembayaran awal menyatu dengan nota. Batalkan penjualannya bila salah input.");
    if (p.journalId) await reverseJournal(tx, p.journalId, await reverseDate(tx, p.date, now), actor, `batal cicilan ${p.sale.number} — ${reason.trim()}`.slice(0, 150));
    await tx.salePayment.update({ where: { id: p.id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await tx.sale.update({ where: { id: p.saleId }, data: { paid: { decrement: p.amount } } });
    if (p.sale.receivable) await tx.receivable.update({ where: { id: p.sale.receivable.id }, data: { paid: { decrement: p.amount } } });
    await audit(actor, "PENJUALAN_CICILAN_DIBATALKAN", "Sale", p.saleId, { number: p.sale.number, amount: Number(p.amount), reason }, tx);
    return p.sale;
  });
}

/**
 * Batalkan penjualan salah input: jurnal penjualan & HPP dibalik, barang jadi kembali ke gudang (harga pokok semula),
 * piutangnya dihapus. Ditolak bila sudah ada cicilan (batalkan cicilannya dulu).
 */
export async function cancelSale(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${id} FOR UPDATE`;
    const s = await tx.sale.findUniqueOrThrow({ where: { id }, include: { lines: true, payments: true, receivable: true } });
    if (s.cancelledAt) throw new StockError(`${s.number} sudah dibatalkan`);
    if (s.payments.some((p) => !p.initial && !p.cancelledAt)) throw new StockError(`${s.number} sudah dicicil. Batalkan cicilannya dulu.`);
    const date = await reverseDate(tx, s.date, now);
    const why = `batal ${s.number} — ${reason.trim()}`.slice(0, 150);
    if (s.journalId) await reverseJournal(tx, s.journalId, date, actor, why);
    const { finished } = await locationSettings(tx);
    const moves = await tx.stockMovement.findMany({ where: { ref: s.number, type: "PENGELUARAN" } });
    for (const m of moves) {
      if (m.journalId) await reverseJournal(tx, m.journalId, date, actor, why);
      const loc = m.fromLocationId ?? finished;
      if (!loc) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
      // Barang kembali dengan harga pokok saat dijual (HPP-nya sudah dibalik di atas)
      await recordMovement(tx, { type: "PENERIMAAN", itemId: m.itemId, qty: Number(m.qty), toLocationId: loc, unitCost: Number(m.unitCost), ref: `BATAL ${s.number}`, note: `Pembatalan ${s.number}`, date, noJournal: true }, actor);
    }
    if (s.receivable) await tx.receivable.delete({ where: { id: s.receivable.id } });
    await tx.salePayment.updateMany({ where: { saleId: id, cancelledAt: null }, data: { cancelledAt: now, cancelReason: "Penjualan dibatalkan" } });
    const out = await tx.sale.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300), paid: BigInt(0) } });
    await audit(actor, "PENJUALAN_DIBATALKAN", "Sale", id, { number: s.number, reason }, tx);
    return out;
  });
}

/** Harga jual offline terakhir per barang jadi (dari Produk & HPP yang terhubung ke barang tsb) */
export async function offlinePrices(db: Tx | typeof prisma = prisma) {
  const products = await db.product.findMany({ where: { finishedItemId: { not: null } }, select: { finishedItemId: true, prices: { where: { channel: "OFFLINE" }, orderBy: { effectiveAt: "desc" }, take: 1 } } });
  const m = new Map<string, number>();
  for (const p of products) if (p.finishedItemId && p.prices[0]) m.set(p.finishedItemId, Number(p.prices[0].price));
  return m;
}
