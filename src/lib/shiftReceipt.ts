import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { nextNumber } from "./numbering";
import { shiftEndAt } from "./shiftReport";
import { StockError } from "./stock";
import { receivePurchaseTx } from "./purchaseReceive";

type Tx = Prisma.TransactionClient;
type DB = Tx | typeof prisma;
type Actor = { id: string; name: string };

/**
 * Barang masuk dari supplier/toko yang dilaporkan divisi di laporan shift.
 * - Dicatat SEBELUM stok akhir dihitung. Fisiknya sudah ada di gudang, tapi stok sistem baru bertambah
 *   saat Owner/Admin menautkannya ke Stok → Pembelian (harga & hutang).
 * - Selama belum ditautkan, stock opname laporan shift menganggap barang ini sudah ada (tidak jadi pemakaian/HPP).
 * - Saat ditautkan, stok masuk bertanggal waktu barang masuk, jadi tidak dobel dengan hitungan fisik.
 */
export type ReceiptInput = {
  itemId: string; qty: number; supplierName?: string | null; photoPath?: string | null; photoMime?: string | null;
  /** Barang ini datang dari pesanan yang sedang dikirim: langsung jadi penerimaan pesanan (stok, uang muka/hutang) */
  purchaseLineId?: string | null;
  /** Pesanan COD: rekening/dompet yang dipakai membayar */
  bankAccountId?: string | null;
};

export async function addShiftReceipt(reportId: string, input: ReceiptInput, actor: Actor, now: Date = new Date()) {
  if (!(input.qty > 0)) throw new StockError("Jumlah barang masuk harus lebih dari 0");
  return prisma.$transaction(async (tx) => {
    const r = await tx.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true } });
    const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId } });
    if (item.divisionId !== r.divisionId || item.type !== "BAHAN_BAKU") throw new StockError("Pilih bahan baku divisi ini");
    // Waktu masuk tidak melewati jam selesai shift: barang tetap dihitung di stok akhir shift laporan ini
    const receivedAt = shiftEndAt(r.date, r.shift, now);
    const number = await nextNumber(tx, "BMK", receivedAt);
    const x = await tx.shiftReceipt.create({
      data: {
        number, reportId: r.id, divisionId: r.divisionId, itemId: item.id, qty: new Prisma.Decimal(Math.round(input.qty * 1000) / 1000),
        supplierName: input.supplierName?.trim().slice(0, 80) || null, photoPath: input.photoPath ?? null, photoMime: input.photoMime ?? null, receivedAt, createdBy: actor.name,
      },
    });
    if (input.purchaseLineId) {
      const line = await tx.purchaseLine.findUniqueOrThrow({ where: { id: input.purchaseLineId }, include: { purchase: true } });
      if (line.itemId !== item.id) throw new StockError("Barang tidak sama dengan barang di pesanan");
      // Stok masuk bertanggal waktu barang masuk → stok akhir shift tetap pas (tidak dobel)
      await receivePurchaseTx(tx, { purchaseId: line.purchaseId, date: receivedAt, lines: [{ lineId: line.id, qty: Number(x.qty) }], bankAccountId: input.bankAccountId, photoPath: input.photoPath, photoMime: input.photoMime, shiftReceiptId: x.id, note: `Barang masuk ${number} (laporan shift)` }, actor);
      await tx.shiftReceipt.update({ where: { id: x.id }, data: { purchaseId: line.purchaseId, supplierName: x.supplierName ?? line.purchase.vendor } });
    }
    if (r.status === "TERKIRIM") await tx.shiftReport.update({ where: { id: r.id }, data: { status: "DIREVISI" } });
    await audit(actor, "BARANG_MASUK_LAPORAN", "ShiftReceipt", x.id, { number, item: item.sku, qty: input.qty }, tx);
    return x;
  });
}

/** Hapus barang masuk yang salah catat: hanya sebelum laporannya dikirim dan belum ditautkan ke Pembelian */
export async function removeShiftReceipt(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const x = await tx.shiftReceipt.findUniqueOrThrow({ where: { id }, include: { report: true } });
    if (x.purchaseId) throw new StockError("Barang masuk ini sudah ditautkan ke Pembelian");
    if (x.report.stockApplied) throw new StockError("Laporan sudah dikirim, stok akhirnya sudah tercatat. Minta Owner/Admin menyesuaikan lewat Mutasi stok.");
    await tx.shiftReceipt.delete({ where: { id } });
    await audit(actor, "BARANG_MASUK_DIHAPUS", "ShiftReceipt", id, { number: x.number }, tx);
  });
}

/** Barang masuk yang belum ditautkan ke Pembelian (fisik ada, stok sistem belum), per barang, sampai waktu `until` */
export async function pendingReceipts(db: DB, itemIds: string[], until: Date) {
  if (!itemIds.length) return [];
  return db.shiftReceipt.findMany({ where: { itemId: { in: itemIds }, purchaseId: null, receivedAt: { lte: until } }, select: { id: true, itemId: true, qty: true } });
}

/** Semua barang masuk (tertaut atau belum) per barang sampai waktu `until` */
export async function receiptsUntil(db: DB, itemIds: string[], until: Date) {
  if (!itemIds.length) return [];
  return db.shiftReceipt.findMany({ where: { itemId: { in: itemIds }, receivedAt: { lte: until } }, select: { id: true, itemId: true, qty: true } });
}

/** Barang masuk belum ditautkan, dikelompokkan per laporan + nama toko (biasanya satu nota) untuk menu Pembelian */
export async function unlinkedReceiptGroups(db: DB = prisma) {
  const rows = await db.shiftReceipt.findMany({
    where: { purchaseId: null },
    include: { item: true, report: { include: { division: true, shift: true } } },
    orderBy: [{ receivedAt: "asc" }, { number: "asc" }],
  });
  const groups = new Map<string, { key: string; report: (typeof rows)[number]["report"]; supplierName: string | null; rows: typeof rows }>();
  for (const x of rows) {
    const key = `${x.reportId}|${(x.supplierName ?? "").toLowerCase()}`;
    const g = groups.get(key) ?? { key, report: x.report, supplierName: x.supplierName, rows: [] };
    g.rows.push(x);
    groups.set(key, g);
  }
  return [...groups.values()];
}
