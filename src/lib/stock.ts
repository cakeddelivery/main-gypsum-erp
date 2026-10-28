import { Prisma, type ItemType, type MovementType, type ProductionStage } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, reverseJournal, COA } from "./accounting";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;
type DB = Tx | typeof prisma;
type Actor = { id: string; name: string };

export class StockError extends Error {}

export const INVENTORY_COA: Record<ItemType, string> = {
  BAHAN_BAKU: COA.PERSEDIAAN_BAHAN,
  BARANG_DALAM_PROSES: COA.PERSEDIAAN_BDP,
  BARANG_JADI: COA.PERSEDIAAN_JADI,
};

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  BAHAN_BAKU: "Bahan Baku",
  BARANG_DALAM_PROSES: "Barang Dalam Proses",
  BARANG_JADI: "Barang Jadi",
};

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  PENERIMAAN: "Penerimaan",
  PENGELUARAN: "Pengeluaran",
  TRANSFER: "Transfer",
  PENYESUAIAN: "Penyesuaian",
  KONSUMSI_PRODUKSI: "Konsumsi Produksi",
  HASIL_PRODUKSI: "Hasil Produksi",
};

/** Saldo stok per item per lokasi */
export async function stockBalances(db: DB = prisma, itemId?: string) {
  const rows = await db.$queryRaw<{ itemId: string; locationId: string; qty: Prisma.Decimal }[]>`
    SELECT "itemId", "locationId", SUM(q) AS qty FROM (
      SELECT "itemId", "toLocationId" AS "locationId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL
      UNION ALL
      SELECT "itemId", "fromLocationId" AS "locationId", -qty AS q FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL
    ) m ${itemId ? Prisma.sql`WHERE "itemId" = ${itemId}` : Prisma.empty}
    GROUP BY "itemId", "locationId"`;
  return rows.map((r) => ({ itemId: r.itemId, locationId: r.locationId, qty: Number(r.qty) }));
}

export async function itemTotals(db: DB = prisma) {
  const rows = await stockBalances(db);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.itemId, (m.get(r.itemId) ?? 0) + r.qty);
  return m;
}

export async function qtyAt(db: DB, itemId: string, locationId: string) {
  const rows = await stockBalances(db, itemId);
  return rows.find((r) => r.locationId === locationId)?.qty ?? 0;
}

export async function lowStockItems(db: DB = prisma) {
  const items = await db.item.findMany({ where: { active: true } });
  const totals = await itemTotals(db);
  return items
    .map((i) => ({ ...i, qty: totals.get(i.id) ?? 0, min: Number(i.minStock) }))
    .filter((i) => i.min > 0 && i.qty < i.min);
}

/** Nilai persediaan (qty × harga rata-rata) per jenis, untuk dicocokkan dengan buku besar */
export async function inventoryValuation(db: DB = prisma) {
  const items = await db.item.findMany();
  const totals = await itemTotals(db);
  const byType: Record<ItemType, number> = { BAHAN_BAKU: 0, BARANG_DALAM_PROSES: 0, BARANG_JADI: 0 };
  const rows = items.map((i) => {
    const qty = totals.get(i.id) ?? 0;
    const value = Math.round(qty * Number(i.avgCost));
    byType[i.type] += value;
    return { id: i.id, sku: i.sku, name: i.name, type: i.type, unit: i.unit, qty, avgCost: Number(i.avgCost), value };
  });
  return { rows, byType, total: byType.BAHAN_BAKU + byType.BARANG_DALAM_PROSES + byType.BARANG_JADI };
}

async function defaultStore(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "default_store_id" } });
  if (!s) throw new StockError("Toko default belum diatur di Pengaturan");
  return s.value;
}

export type MoveInput = {
  type: MovementType;
  itemId: string;
  qty: number;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  unitCost?: number;
  ref?: string | null;
  note?: string | null;
  date?: Date;
  /** Penyesuaian: true = tambah, false = kurang */
  increase?: boolean;
  allowNegative?: boolean;
};

/**
 * Catat mutasi stok. Nilai akuntansi:
 * - PENERIMAAN: hanya kuantitas & harga rata-rata (pembayaran pembelian dibukukan dari Finance, mencegah duplikasi)
 * - PENGELUARAN barang jadi: HPP (Dr HPP / Cr Persediaan Barang Jadi)
 * - PENYESUAIAN: Dr/Cr Persediaan vs Beban Selisih Persediaan
 */
export async function recordMovement(tx: Tx, m: MoveInput, actor: Actor) {
  if (!(m.qty > 0)) throw new StockError("Jumlah harus lebih dari 0");
  const item = await tx.item.findUniqueOrThrow({ where: { id: m.itemId } });
  let from = m.fromLocationId ?? null;
  let to = m.toLocationId ?? null;
  switch (m.type) {
    case "PENERIMAAN":
    case "HASIL_PRODUKSI":
      if (!to) throw new StockError("Lokasi tujuan wajib diisi");
      from = null;
      break;
    case "PENGELUARAN":
    case "KONSUMSI_PRODUKSI":
      if (!from) throw new StockError("Lokasi asal wajib diisi");
      to = null;
      break;
    case "TRANSFER":
      if (!from || !to) throw new StockError("Lokasi asal dan tujuan wajib diisi");
      if (from === to) throw new StockError("Lokasi asal dan tujuan harus berbeda");
      break;
    case "PENYESUAIAN": {
      const loc = from ?? to;
      if (!loc) throw new StockError("Lokasi wajib diisi");
      if (m.increase) { to = loc; from = null; } else { from = loc; to = null; }
      break;
    }
  }
  if (from && !m.allowNegative) {
    const avail = await qtyAt(tx, item.id, from);
    if (avail < m.qty) throw new StockError(`Stok ${item.name} di lokasi asal tidak cukup (tersedia ${avail})`);
  }
  let unitCost = Number(item.avgCost);
  if (m.type === "PENERIMAAN" || m.type === "HASIL_PRODUKSI") {
    unitCost = m.unitCost ?? unitCost;
    // Harga rata-rata bergerak (moving average)
    const totals = await itemTotals(tx);
    const curQty = Math.max(0, totals.get(item.id) ?? 0);
    const newAvg = curQty + m.qty > 0 ? Math.round((curQty * Number(item.avgCost) + m.qty * unitCost) / (curQty + m.qty)) : unitCost;
    await tx.item.update({ where: { id: item.id }, data: { avgCost: BigInt(newAvg) } });
  }
  const mv = await tx.stockMovement.create({
    data: {
      date: m.date ?? new Date(),
      type: m.type,
      itemId: item.id,
      fromLocationId: from,
      toLocationId: to,
      qty: new Prisma.Decimal(m.qty),
      unitCost: BigInt(unitCost),
      ref: m.ref ?? null,
      note: m.note ?? null,
      createdBy: actor.name,
    },
  });
  const value = Math.round(m.qty * unitCost);
  let journalId: string | null = null;
  if (value > 0 && (m.type === "PENYESUAIAN" || (m.type === "PENGELUARAN" && item.type === "BARANG_JADI"))) {
    const inv = INVENTORY_COA[item.type];
    const other = m.type === "PENGELUARAN" ? COA.HPP : COA.BEBAN_SELISIH_PERSEDIAAN;
    const inc = m.type === "PENYESUAIAN" && m.increase;
    const j = await postJournal(tx, {
      date: mv.date,
      storeId: await defaultStore(tx),
      description: `${MOVEMENT_LABEL[m.type]} ${item.sku} ${item.name} × ${m.qty}`,
      source: "STOK",
      sourceId: mv.id,
      actor,
      lines: inc ? [{ accountCode: inv, debit: value }, { accountCode: other, credit: value }] : [{ accountCode: other, debit: value }, { accountCode: inv, credit: value }],
    });
    journalId = j.id;
    await tx.stockMovement.update({ where: { id: mv.id }, data: { journalId } });
  }
  await audit(actor, "MUTASI_STOK", "StockMovement", mv.id, { type: m.type, item: item.sku, qty: m.qty }, tx);
  return mv;
}

// ---------------- PRODUKSI -> STOK & AKUNTANSI ----------------

export async function locationSettings(db: DB) {
  const s = await db.setting.findMany({ where: { key: { in: ["loc_raw", "loc_wip", "loc_finished"] } } });
  const g = (k: string) => s.find((x) => x.key === k)?.value ?? null;
  return { raw: g("loc_raw"), wip: g("loc_wip"), finished: g("loc_finished") };
}

/** Biaya bahan per unit produk dari BOM (qty × harga rata-rata) */
export async function bomMaterialCost(db: DB, productId: string) {
  const lines = await db.bomLine.findMany({ where: { productId }, include: { item: true } });
  return Math.round(lines.reduce((s, l) => s + Number(l.qty) * Number(l.item.avgCost), 0));
}

/**
 * Integrasi produksi:
 * - Tahap CETAK: konsumsi bahan sesuai BOM × (hasil + reject) → Dr BDP / Cr Bahan Baku
 * - Reject tahap setelah CETAK: Dr Beban Reject / Cr BDP (nilai bahan per unit)
 * - Tahap BARANG_JADI: hasil produksi masuk gudang barang jadi → Dr Barang Jadi / Cr BDP
 */
export async function postProductionStock(tx: Tx, entryId: string, actor: Actor) {
  const e = await tx.productionEntry.findUniqueOrThrow({ where: { id: entryId }, include: { product: { include: { bom: { include: { item: true } } } } } });
  if (e.stockPosted) return;
  const locs = await locationSettings(tx);
  const date = new Date(`${e.date.toISOString().slice(0, 10)}T05:00:00.000Z`);
  const unitMat = await bomMaterialCost(tx, e.productId);
  const storeId = e.product.storeId;
  const desc = `Produksi ${e.product.sku} ${e.stage}`;
  if (e.stage === "CETAK" && e.product.bom.length && locs.raw) {
    const units = e.qtyGood + e.qtyReject;
    let total = 0;
    for (const b of e.product.bom) {
      const q = Number(b.qty) * units;
      if (q <= 0) continue;
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: b.itemId, qty: q, fromLocationId: locs.raw, ref: `PRD:${e.id}`, date, allowNegative: true }, actor);
      total += Math.round(q * Number(b.item.avgCost));
    }
    if (total > 0) {
      await postJournal(tx, { date, storeId, description: `${desc}: konsumsi bahan`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.PERSEDIAAN_BDP, debit: total }, { accountCode: COA.PERSEDIAAN_BAHAN, credit: total }] });
    }
  } else if (e.qtyReject > 0 && unitMat > 0) {
    const v = unitMat * e.qtyReject;
    await postJournal(tx, { date, storeId, description: `${desc}: reject ${e.qtyReject}`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.BEBAN_SELISIH_PERSEDIAAN, debit: v }, { accountCode: COA.PERSEDIAAN_BDP, credit: v }] });
  }
  if (e.stage === "BARANG_JADI" && e.qtyGood > 0 && e.product.finishedItemId && locs.finished) {
    await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: e.product.finishedItemId, qty: e.qtyGood, toLocationId: locs.finished, unitCost: unitMat, ref: `PRD:${e.id}`, date }, actor);
    const v = unitMat * e.qtyGood;
    if (v > 0) await postJournal(tx, { date, storeId, description: `${desc}: barang jadi`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.PERSEDIAAN_JADI, debit: v }, { accountCode: COA.PERSEDIAAN_BDP, credit: v }] });
  }
  await tx.productionEntry.update({ where: { id: e.id }, data: { stockPosted: true } });
}

/** Hapus entri produksi: balik mutasi stok & jurnal terkait (jejak tetap tersimpan). */
export async function reverseProductionStock(tx: Tx, entryId: string, actor: Actor) {
  const moves = await tx.stockMovement.findMany({ where: { ref: `PRD:${entryId}` } });
  for (const mv of moves) {
    await tx.stockMovement.create({
      data: { date: new Date(), type: "PENYESUAIAN", itemId: mv.itemId, fromLocationId: mv.toLocationId, toLocationId: mv.fromLocationId, qty: mv.qty, unitCost: mv.unitCost, ref: `BATAL-PRD:${entryId}`, note: "Pembatalan entri produksi", createdBy: actor.name },
    });
  }
  const journals = await tx.journal.findMany({ where: { source: "PRODUKSI", sourceId: entryId } });
  for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, "Entri produksi dihapus");
}

export const STAGES: ProductionStage[] = ["CETAK", "PANEN_1", "SORTIR_1", "OVEN", "PANEN_2", "SORTIR_2", "FILLING_CAT", "ASSEMBLING", "QC", "PACKING", "BARANG_JADI"];
export const STAGE_LABEL: Record<ProductionStage, string> = {
  CETAK: "Cetak",
  PANEN_1: "Panen",
  SORTIR_1: "Sortir",
  OVEN: "Oven",
  PANEN_2: "Panen (pasca oven)",
  SORTIR_2: "Sortir (pasca oven)",
  FILLING_CAT: "Filling Cat",
  ASSEMBLING: "Assembling",
  QC: "QC",
  PACKING: "Packing",
  BARANG_JADI: "Barang Jadi",
};
