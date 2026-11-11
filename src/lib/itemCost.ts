import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Barang dibeli (Pembelian / rincian Transaksi): harga beli terbaru ikut pembelian, dan permintaan stok otomatis
 * yang masih terbuka untuk barang itu ditandai Dipenuhi.
 * Harga manual dari Owner selalu ditimpa pembelian berikutnya (walau tanggal pembeliannya lebih lama).
 */
export async function onItemPurchased(tx: Tx, itemId: string, p: { unitCost: number; qty: number; total: number; date: Date; ref: string; by: string }) {
  const it = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
  if (!it.lastCostAt || it.costManualAt || p.date >= it.lastCostAt) {
    await tx.item.update({
      where: { id: itemId },
      data: { prevCost: it.lastCost > BigInt(0) ? it.lastCost : BigInt(p.unitCost), lastCost: BigInt(p.unitCost), lastCostAt: p.date, buyPrice: BigInt(Math.round(p.total)), buyQty: p.qty, costManualAt: null, costManualBy: null },
    });
  }
  await tx.stockRequest.updateMany({ where: { itemId, auto: true, status: { in: ["DIAJUKAN", "DISETUJUI"] } }, data: { status: "DIPENUHI", decidedBy: `${p.by} (pembelian ${p.ref})` } });
}
