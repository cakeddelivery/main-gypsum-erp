import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA, type LineInput } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { locationSettings, recordMovement, StockError } from "./stock";
import { onItemPurchased } from "./itemCost";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

export type ReceiveInput = {
  purchaseId: string;
  date: Date;
  /** Jumlah yang datang per baris pesanan (satuan beli) */
  lines: { lineId: string; qty: number }[];
  /** COD: rekening/dompet yang dipakai membayar saat barang datang */
  bankAccountId?: string | null;
  photoPath?: string | null;
  photoMime?: string | null;
  note?: string | null;
  /** Barang masuk di laporan shift yang memvalidasi penerimaan ini */
  shiftReceiptId?: string | null;
};

/** Sisa uang muka yang belum terpakai untuk barang yang sudah diterima */
export const prepaidLeft = (p: { paidNow: bigint; prepaidUsed: bigint }) => Number(p.paidNow - p.prepaidUsed);

/**
 * Terima barang pesanan (validasi barang datang, boleh sebagian):
 * stok masuk gudang bahan baku; Dr Persediaan = nilai barang yang datang,
 * Cr Uang Muka Pembelian (sejauh sudah dibayar di muka), sisanya Cr rekening (COD) atau Cr Hutang Usaha (hutang supplier).
 */
export async function receivePurchaseTx(tx: Tx, input: ReceiveInput, actor: Actor) {
  await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${input.purchaseId} FOR UPDATE`;
  const p = await tx.purchase.findUniqueOrThrow({ where: { id: input.purchaseId }, include: { lines: { include: { item: true } }, deliveries: true } });
  if (p.cancelledAt) throw new StockError(`${p.number} sudah dibatalkan`);
  if (p.delivery === "DITERIMA" || p.delivery === "DITUTUP") throw new StockError(`${p.number} sudah selesai, tidak ada barang yang ditunggu`);
  const want = input.lines.filter((l) => l.qty > 0);
  if (!want.length) throw new StockError("Isi jumlah barang yang datang");
  const { raw } = await locationSettings(tx);
  if (!raw) throw new StockError("Lokasi gudang bahan baku belum diatur di Pengaturan");
  // Nilai yang sudah diterima per baris (dari penerimaan sebelumnya) agar baris yang lengkap pas dengan total harganya
  const priorValue = new Map<string, number>();
  for (const d of p.deliveries) for (const x of d.lines as { lineId: string; amount: number }[]) priorValue.set(x.lineId, (priorValue.get(x.lineId) ?? 0) + x.amount);
  const got: { lineId: string; itemId: string; qty: number; amount: number; unitCost: number; name: string }[] = [];
  for (const w of want) {
    const l = p.lines.find((x) => x.id === w.lineId);
    if (!l) throw new StockError("Baris pesanan tidak ditemukan");
    const qty = Math.round(w.qty * 1000) / 1000;
    const remaining = Number(l.qty) - Number(l.qtyReceived);
    if (qty > remaining + 0.0005) throw new StockError(`${l.item.name}: datang ${qty} melebihi sisa pesanan ${remaining} ${l.item.unit}`);
    const full = Math.abs(qty - remaining) <= 0.0005;
    const amount = full ? Number(l.amount) - (priorValue.get(l.id) ?? 0) : Math.round((Number(l.amount) * qty) / Number(l.qty));
    got.push({ lineId: l.id, itemId: l.itemId, qty, amount, unitCost: Number(l.unitCost), name: l.item.name });
  }
  const value = got.reduce((s, g) => s + g.amount, 0);
  const fromPrepaid = Math.min(value, prepaidLeft(p));
  const rest = value - fromPrepaid;
  const bank = rest > 0 && p.cod ? (input.bankAccountId ? await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } }) : null) : null;
  if (rest > 0 && p.cod && !bank) throw new StockError("COD: pilih rekening/dompet yang dipakai membayar");
  const number = await nextNumber(tx, "TRM", input.date);
  const jl: LineInput[] = [{ accountCode: COA.PERSEDIAAN_BAHAN, debit: value }];
  if (fromPrepaid > 0) jl.push({ accountCode: COA.UANG_MUKA_PEMBELIAN, credit: fromPrepaid, memo: "Dari uang muka" });
  if (rest > 0 && bank) jl.push({ accountId: bank.coaAccountId, credit: rest, memo: "COD" });
  if (rest > 0 && !bank) jl.push({ accountCode: COA.UTANG_USAHA, credit: rest, memo: "Belum dibayar" });
  const j = value > 0 ? await postJournal(tx, { date: input.date, storeId: p.storeId, description: `Terima barang ${number} (${p.number} ${p.vendor})`, source: "PEMBELIAN", sourceId: number, actor, lines: jl }) : null;
  const payable = rest > 0 && !bank
    ? await tx.payable.create({ data: { number: await nextNumber(tx, "UTG", input.date), vendor: p.vendor, supplierId: p.supplierId, storeId: p.storeId, date: input.date, dueDate: p.dueDate, amount: BigInt(rest), note: `Barang diterima ${number} (${p.number})`, journalId: j?.id ?? null } })
    : null;
  for (const g of got) {
    await recordMovement(tx, { type: "PENERIMAAN", itemId: g.itemId, qty: g.qty, toLocationId: raw, unitCost: g.unitCost, ref: p.number, note: `Terima barang ${number} ${p.vendor}`, date: input.date }, actor);
    await onItemPurchased(tx, g.itemId, { unitCost: g.unitCost, qty: g.qty, total: g.amount, date: input.date, ref: number, by: actor.name });
    await tx.purchaseLine.update({ where: { id: g.lineId }, data: { qtyReceived: { increment: g.qty } } });
  }
  const lines = await tx.purchaseLine.findMany({ where: { purchaseId: p.id } });
  const done = lines.every((l) => Number(l.qtyReceived) >= Number(l.qty) - 0.0005);
  await tx.purchase.update({ where: { id: p.id }, data: { delivery: done ? "DITERIMA" : "SEBAGIAN", prepaidUsed: { increment: BigInt(fromPrepaid) }, codPaid: { increment: BigInt(bank ? rest : 0) } } });
  const rc = await tx.purchaseReceipt.create({
    data: {
      number, purchaseId: p.id, date: input.date, lines: got.map(({ lineId, itemId, qty, amount }) => ({ lineId, itemId, qty, amount })), value: BigInt(value), fromPrepaid: BigInt(fromPrepaid),
      codPaid: BigInt(bank ? rest : 0), toPayable: BigInt(payable ? rest : 0), bankAccountId: bank?.id ?? null, payableId: payable?.id ?? null, journalId: j?.id ?? null,
      shiftReceiptId: input.shiftReceiptId ?? null, photoPath: input.photoPath ?? null, photoMime: input.photoMime ?? null, note: input.note ?? null, receivedBy: actor.name,
    },
  });
  await audit(actor, "BARANG_DITERIMA", "PurchaseReceipt", rc.id, { number, purchase: p.number, value, fromPrepaid, cod: bank ? rest : 0, hutang: payable ? rest : 0, lines: got.map((g) => `${g.name} × ${g.qty}`) }, tx);
  return { receipt: rc, done, value, fromPrepaid, rest, payable };
}

export function receivePurchase(input: ReceiveInput, actor: Actor) {
  return prisma.$transaction((tx) => receivePurchaseTx(tx, input, actor));
}

/**
 * Tutup pesanan yang sisanya tidak akan datang. Uang muka yang belum terpakai jadi piutang ke supplier (refund),
 * Dr Piutang Usaha / Cr Uang Muka Pembelian. Barang yang sudah diterima tetap.
 */
export async function closePurchase(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new StockError("Alasan wajib diisi");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${id} FOR UPDATE`;
    const p = await tx.purchase.findUniqueOrThrow({ where: { id } });
    if (p.cancelledAt) throw new StockError(`${p.number} sudah dibatalkan`);
    if (p.delivery !== "MENUNGGU" && p.delivery !== "SEBAGIAN") throw new StockError(`${p.number} tidak sedang menunggu barang`);
    const left = prepaidLeft(p);
    let receivable: { number: string } | null = null;
    if (left > 0) {
      const j = await postJournal(tx, { date: now, storeId: p.storeId, description: `Sisa pesanan ${p.number} tidak datang: refund dari ${p.vendor}`, source: "PEMBELIAN", sourceId: p.number, actor, lines: [{ accountCode: COA.PIUTANG, debit: left, memo: "Refund supplier" }, { accountCode: COA.UANG_MUKA_PEMBELIAN, credit: left }] });
      receivable = await tx.receivable.create({ data: { number: await nextNumber(tx, "PIU", now), customer: p.vendor, storeId: p.storeId, date: now, amount: BigInt(left), note: `Refund supplier: sisa pesanan ${p.number} tidak datang`, journalId: j.id } });
    }
    await tx.purchase.update({ where: { id }, data: { delivery: "DITUTUP", prepaidUsed: { increment: BigInt(left) }, closedReason: reason.trim().slice(0, 300) } });
    await audit(actor, "PESANAN_DITUTUP", "Purchase", id, { number: p.number, reason, refund: left, piutang: receivable?.number ?? null }, tx);
    return { refund: left, receivable };
  });
}

/** Pesanan yang masih menunggu barang (untuk menu Pembelian, laporan shift & Beranda) */
export function pendingDeliveries(db: Tx | typeof prisma = prisma, itemIds?: string[]) {
  return db.purchase.findMany({
    where: { cancelledAt: null, delivery: { in: ["MENUNGGU", "SEBAGIAN"] }, ...(itemIds ? { lines: { some: { itemId: { in: itemIds } } } } : {}) },
    include: { lines: { include: { item: true } }, deliveries: { orderBy: { date: "asc" } } },
    orderBy: { date: "asc" },
  });
}
