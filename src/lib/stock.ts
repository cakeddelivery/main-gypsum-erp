import { Prisma, type ItemType, type MovementType, type ProductionStage } from "@prisma/client";
import { bomLineCost, bomStockQty } from "./unitcost";
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
  BARANG_DALAM_PROSES: "Barang Setengah Jadi",
  BARANG_JADI: "Produk Jadi",
};

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  PENERIMAAN: "Penerimaan",
  PENGELUARAN: "Pengeluaran",
  TRANSFER: "Transfer",
  PENYESUAIAN: "Penyesuaian",
  KONSUMSI_PRODUKSI: "Konsumsi Produksi",
  HASIL_PRODUKSI: "Hasil Produksi",
};

/** Saldo stok per item per lokasi. Filter item dipasang di tiap cabang UNION agar memakai index (bukan scan penuh). */
export async function stockBalances(db: DB = prisma, itemId?: string) {
  const byTo = itemId ? Prisma.sql`AND "itemId" = ${itemId}` : Prisma.empty;
  const byFrom = itemId ? Prisma.sql`AND "itemId" = ${itemId}` : Prisma.empty;
  const rows = await db.$queryRaw<{ itemId: string; locationId: string; qty: Prisma.Decimal }[]>`
    SELECT "itemId", "locationId", SUM(q) AS qty FROM (
      SELECT "itemId", "toLocationId" AS "locationId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL ${byTo}
      UNION ALL
      SELECT "itemId", "fromLocationId" AS "locationId", -qty AS q FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL ${byFrom}
    ) m
    GROUP BY "itemId", "locationId"`;
  return rows.map((r) => ({ itemId: r.itemId, locationId: r.locationId, qty: Number(r.qty) }));
}

export async function itemTotals(db: DB = prisma) {
  const rows = await stockBalances(db);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.itemId, (m.get(r.itemId) ?? 0) + r.qty);
  return m;
}

/** Total stok satu barang di semua lokasi (hanya membaca mutasi barang itu) */
export async function itemQty(db: DB, itemId: string) {
  const rows = await db.$queryRaw<{ qty: Prisma.Decimal | null }[]>`
    SELECT SUM(CASE WHEN "toLocationId" IS NOT NULL THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" IS NOT NULL THEN qty ELSE 0 END) AS qty
    FROM "StockMovement" WHERE "itemId" = ${itemId}`;
  return Number(rows[0]?.qty ?? 0);
}

/** Stok barang di satu lokasi; `until` = hanya mutasi sampai waktu itu (stok per jam tertentu) */
export async function qtyAt(db: DB, itemId: string, locationId: string, until?: Date) {
  const rows = await db.$queryRaw<{ qty: Prisma.Decimal | null }[]>`
    SELECT SUM(CASE WHEN "toLocationId" = ${locationId} THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" = ${locationId} THEN qty ELSE 0 END) AS qty
    FROM "StockMovement" WHERE "itemId" = ${itemId} AND ("toLocationId" = ${locationId} OR "fromLocationId" = ${locationId})
    ${until ? Prisma.sql`AND "date" <= ${until}` : Prisma.empty}`;
  return Number(rows[0]?.qty ?? 0);
}

/**
 * Kunci baris barang (SELECT ... FOR UPDATE) sampai transaksi selesai.
 * Semua mutasi stok barang yang sama jadi antre satu per satu: cek "stok cukup" dan harga rata-rata
 * tidak bisa dibaca bersamaan oleh dua permintaan. Urutan id dibuat tetap agar tidak saling mengunci (deadlock).
 */
export async function lockItems(tx: Tx, itemIds: string[]) {
  const ids = [...new Set(itemIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw`SELECT id FROM "Item" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
}

export async function lowStockItems(db: DB = prisma) {
  const items = await db.item.findMany({ where: { active: true } });
  const totals = await itemTotals(db);
  return items
    .map((i) => ({ ...i, qty: totals.get(i.id) ?? 0, min: Number(i.minStock) }))
    .filter((i) => needsReorder(i.qty, i.min));
}

/** Perlu reorder bila stok menyentuh atau di bawah batas minimum (sama dengan Laporan Shift) */
export function needsReorder(qty: number, min: number) {
  return min > 0 && qty <= min;
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

/**
 * Nilai persediaan (qty × harga rata-rata) per lokasi × jenis: gudang, titik borongan, driver.
 * Total semua lokasi = nilai persediaan di Neraca (akun Persediaan Bahan Baku / Barang Dalam Proses / Barang Jadi).
 */
export async function valuationByLocation(db: DB = prisma) {
  const [items, locs, balances] = await Promise.all([
    db.item.findMany({ select: { id: true, type: true, avgCost: true } }),
    db.location.findMany({ orderBy: { code: "asc" } }),
    stockBalances(db),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = locs.map((l) => ({ id: l.id, code: l.code, name: l.name, BAHAN_BAKU: 0, BARANG_DALAM_PROSES: 0, BARANG_JADI: 0, total: 0 }));
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  for (const b of balances) {
    const it = byId.get(b.itemId);
    const r = rowOf.get(b.locationId);
    if (!it || !r) continue;
    const v = Math.round(b.qty * Number(it.avgCost));
    r[it.type] += v;
    r.total += v;
  }
  const shown = rows.filter((r) => r.BAHAN_BAKU || r.BARANG_DALAM_PROSES || r.BARANG_JADI);
  const sum = (k: ItemType | "total") => shown.reduce((a, r) => a + r[k], 0);
  return { rows: shown, total: { BAHAN_BAKU: sum("BAHAN_BAKU"), BARANG_DALAM_PROSES: sum("BARANG_DALAM_PROSES"), BARANG_JADI: sum("BARANG_JADI"), total: sum("total") } };
}

async function defaultStore(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "default_store_id" } });
  if (!s) throw new StockError("Toko default belum diatur di Pengaturan");
  return s.value;
}

/** Kode akun HPP "Pemakaian Bahan Baku" (migrasi 20261113100000); cadangan Beban Selisih bila belum ada */
export async function usageAccountCode(db: DB): Promise<string> {
  const s = await db.setting.findUnique({ where: { key: "coa_pemakaian_bahan" } });
  if (s?.value) return s.value;
  const a = await db.coaAccount.findFirst({ where: { name: "Pemakaian Bahan Baku" } });
  return a?.code ?? COA.BEBAN_SELISIH_PERSEDIAAN;
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
  /** Jangan buat jurnal (nilainya sudah dibalik oleh jurnal lain, mis. pembatalan transaksi) */
  noJournal?: boolean;
  /** Opname barang jadi: selisih kurang = barang terjual → HPP (bukan beban selisih) */
  hpp?: boolean;
  /** Stock opname laporan shift: selisih bahan = pemakaian bahan → akun HPP "Pemakaian Bahan Baku" */
  usage?: boolean;
  /** Barang keluar dengan harga pokok rata-rata 0: pakai nilai ini (mis. HPP resep), dicatat di keterangan jurnal */
  fallbackUnitCost?: { value: number; note: string } | null;
};

/**
 * Catat mutasi stok. Nilai akuntansi:
 * - PENERIMAAN: hanya kuantitas & harga rata-rata (pembayaran pembelian dibukukan dari Finance, mencegah duplikasi)
 * - PENGELUARAN barang jadi: HPP (Dr HPP / Cr Persediaan Barang Jadi)
 * - PENGELUARAN bahan baku / setengah jadi: Dr Beban Selisih Persediaan / Cr Persediaan (stok & buku besar tetap cocok)
 * - PENYESUAIAN: Dr/Cr Persediaan vs Beban Selisih Persediaan; opname barang jadi yang berkurang → HPP
 */
export async function recordMovement(tx: Tx, m: MoveInput, actor: Actor) {
  if (!(m.qty > 0)) throw new StockError("Jumlah harus lebih dari 0");
  // Kunci dulu, baru baca: stok & harga rata-rata yang dibaca di bawah sudah pasti terbaru
  await lockItems(tx, [m.itemId]);
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
  let costNote = "";
  if (unitCost <= 0 && m.fallbackUnitCost && m.fallbackUnitCost.value > 0 && m.type !== "PENERIMAAN" && m.type !== "HASIL_PRODUKSI") {
    unitCost = Math.round(m.fallbackUnitCost.value);
    costNote = ` (${m.fallbackUnitCost.note})`;
  }
  if (m.type === "PENERIMAAN" || m.type === "HASIL_PRODUKSI") {
    unitCost = m.unitCost ?? unitCost;
    // Harga rata-rata bergerak (moving average)
    const curQty = Math.max(0, await itemQty(tx, item.id));
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
  if (value > 0 && !m.noJournal && (m.type === "PENYESUAIAN" || m.type === "PENGELUARAN")) {
    const inv = INVENTORY_COA[item.type];
    const inc = m.type === "PENYESUAIAN" && m.increase;
    const toHpp = item.type === "BARANG_JADI" && !inc && (m.type === "PENGELUARAN" || m.hpp);
    const other = toHpp ? COA.HPP : m.usage && m.type === "PENYESUAIAN" ? await usageAccountCode(tx) : COA.BEBAN_SELISIH_PERSEDIAAN;
    const j = await postJournal(tx, {
      date: mv.date,
      storeId: await defaultStore(tx),
      description: `${m.hpp && !inc ? "Barang terjual (opname)" : m.usage ? "Pemakaian bahan (laporan shift)" : MOVEMENT_LABEL[m.type]} ${item.sku} ${item.name} × ${m.qty}${costNote}`,
      source: "STOK",
      sourceId: mv.id,
      actor,
      lines: inc ? [{ accountCode: inv, debit: value }, { accountCode: other, credit: value }] : [{ accountCode: other, debit: value }, { accountCode: inv, credit: value }],
    });
    journalId = j.id;
    await tx.stockMovement.update({ where: { id: mv.id }, data: { journalId } });
  }
  await audit(actor, "MUTASI_STOK", "StockMovement", mv.id, { type: m.type, item: item.sku, qty: m.qty }, tx);
  return { ...mv, journalId };
}

// ---------------- PRODUKSI -> STOK & AKUNTANSI ----------------

/** Stok minus per item per lokasi (konsumsi produksi/borongan melebihi stok tercatat) */
export async function negativeStock(db: DB = prisma) {
  const rows = (await stockBalances(db)).filter((r) => r.qty < -0.0005);
  if (!rows.length) return [];
  const [items, locs] = await Promise.all([db.item.findMany({ where: { id: { in: rows.map((r) => r.itemId) } } }), db.location.findMany({ where: { id: { in: rows.map((r) => r.locationId) } } })]);
  return rows.map((r) => ({ ...r, item: items.find((i) => i.id === r.itemId)!, location: locs.find((l) => l.id === r.locationId)! }));
}

export type OpnameRow = { itemId: string; physical: number };

/**
 * Opname barang jadi (akhir bulan) di gudang barang jadi: stok sistem disamakan dengan hitungan fisik.
 * Berkurang = barang terjual/keluar → Dr HPP / Cr Persediaan Barang Jadi; bertambah = Dr Persediaan / Cr Beban Selisih.
 */
export async function finishedGoodsOpname(rows: OpnameRow[], date: Date, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const { finished } = await locationSettings(tx);
    if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
    const ref = `OPN-${date.toISOString().slice(0, 10)}`;
    let sold = 0;
    let value = 0;
    let changed = 0;
    for (const r of rows) {
      if (!(r.physical >= 0)) throw new StockError("Jumlah fisik tidak boleh minus");
      const item = await tx.item.findUniqueOrThrow({ where: { id: r.itemId } });
      if (item.type !== "BARANG_JADI") throw new StockError(`${item.name} bukan produk jadi`);
      const sys = await qtyAt(tx, item.id, finished);
      const diff = Math.round((r.physical - sys) * 1000) / 1000;
      if (!diff) continue;
      const mv = await recordMovement(tx, { type: "PENYESUAIAN", itemId: item.id, qty: Math.abs(diff), fromLocationId: finished, increase: diff > 0, hpp: true, ref, note: `Opname barang jadi: sistem ${sys}, fisik ${r.physical}`, date }, actor);
      if (diff < 0) {
        sold += -diff;
        value += Math.round(-diff * Number(mv.unitCost));
      }
      changed++;
    }
    await audit(actor, "OPNAME_BARANG_JADI", "StockMovement", null, { ref, items: changed, sold, hpp: value }, tx);
    return { changed, sold, hpp: value };
  });
}

export async function locationSettings(db: DB) {
  const s = await db.setting.findMany({ where: { key: { in: ["loc_raw", "loc_wip", "loc_finished"] } } });
  const g = (k: string) => s.find((x) => x.key === k)?.value ?? null;
  return { raw: g("loc_raw"), wip: g("loc_wip"), finished: g("loc_finished") };
}

/** Biaya bahan per unit produk dari BOM (qty × harga rata-rata) */
export async function bomMaterialCost(db: DB, productId: string) {
  const lines = await db.bomLine.findMany({ where: { productId }, include: { item: true } });
  return Math.round(lines.reduce((s, l) => s + bomLineCost(l.qty, l.item, Number(l.item.avgCost)), 0));
}

/**
 * Integrasi produksi:
 * - Tahap CETAK: konsumsi bahan sesuai BOM × (hasil + reject) → Dr BDP / Cr Bahan Baku
 * - Reject semua tahap (termasuk CETAK): Dr Beban Selisih Persediaan / Cr BDP (nilai bahan per unit)
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
      const q = bomStockQty(b.qty, b.item) * units;
      if (q <= 0) continue;
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: b.itemId, qty: q, fromLocationId: locs.raw, ref: `PRD:${e.id}`, date, allowNegative: true }, actor);
      total += Math.round(q * Number(b.item.avgCost));
    }
    if (total > 0) {
      await postJournal(tx, { date, storeId, description: `${desc}: konsumsi bahan`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.PERSEDIAAN_BDP, debit: total }, { accountCode: COA.PERSEDIAAN_BAHAN, credit: total }] });
    }
  }
  // Reject (termasuk tahap Cetak yang bahannya baru saja masuk BDP) langsung dibebankan, agar tidak mengendap di BDP
  if (e.qtyReject > 0 && unitMat > 0 && (e.stage !== "CETAK" || (e.product.bom.length && locs.raw))) {
    const v = unitMat * e.qtyReject;
    await postJournal(tx, { date, storeId, description: `${desc}: reject ${e.qtyReject}`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.BEBAN_SELISIH_PERSEDIAAN, debit: v }, { accountCode: COA.PERSEDIAAN_BDP, credit: v }] });
  }
  if (e.stage === "BARANG_JADI" && e.qtyGood > 0 && e.product.finishedItemId && locs.finished) {
    // Bahan belum bernilai di BDP (resep tanpa harga rata-rata): nilai barang jadi dari resep produk, diambil dari
    // akun HPP "Pemakaian Bahan Baku" (bahan sudah dibebankan lewat stock opname laporan shift)
    const fromRecipe = unitMat > 0 ? 0 : await (await import("./hpp")).recipeMaterialCost(e.product.finishedItemId);
    const unit = unitMat > 0 ? unitMat : fromRecipe;
    await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: e.product.finishedItemId, qty: e.qtyGood, toLocationId: locs.finished, unitCost: unit, ref: `PRD:${e.id}`, date }, actor);
    const v = unit * e.qtyGood;
    if (v > 0) {
      const credit = unitMat > 0 ? COA.PERSEDIAAN_BDP : await usageAccountCode(tx);
      await postJournal(tx, { date, storeId, description: `${desc}: barang jadi${unitMat > 0 ? "" : " (nilai dari resep)"}`, source: "PRODUKSI", sourceId: e.id, actor, lines: [{ accountCode: COA.PERSEDIAAN_JADI, debit: v }, { accountCode: credit, credit: v }] });
    }
  }
  await tx.productionEntry.update({ where: { id: e.id }, data: { stockPosted: true } });
}

/** Harga rata-rata baru bila stok `qty` dengan harga `unitCost` dikeluarkan kembali (kebalikan rata-rata bergerak) */
export function avgAfterRemoval(curQty: number, avg: number, qty: number, unitCost: number) {
  const rest = curQty - qty;
  // Stok habis/minus: tidak ada sisa untuk dirata-rata, harga terakhir dipertahankan
  if (rest <= 0.0005) return avg;
  return Math.max(0, Math.round((curQty * avg - qty * unitCost) / rest));
}

/** Harga rata-rata baru bila stok `qty` dengan harga `unitCost` masuk kembali */
export function avgAfterReturn(curQty: number, avg: number, qty: number, unitCost: number) {
  const cur = Math.max(0, curQty);
  return cur + qty > 0 ? Math.round((cur * avg + qty * unitCost) / (cur + qty)) : unitCost;
}

/**
 * Balik semua mutasi stok dengan `ref` tertentu (hapus produksi / setoran borongan).
 * Selain kuantitas, harga pokok rata-rata (avgCost) ikut dikembalikan:
 * - barang yang dulu MASUK (hasil produksi) dikeluarkan lagi → rata-rata dihitung ulang tanpa barang itu
 * - barang yang dulu KELUAR (konsumsi bahan) dikembalikan dengan harga saat keluar
 * Jurnalnya dibalik terpisah oleh pemanggil.
 */
export async function reverseMovementsByRef(tx: Tx, ref: string, reversalRef: string, note: string, actor: Actor) {
  const moves = await tx.stockMovement.findMany({ where: { ref }, orderBy: { id: "asc" } });
  await lockItems(tx, moves.map((m) => m.itemId));
  for (const mv of moves) {
    const qty = Number(mv.qty);
    const unitCost = Number(mv.unitCost);
    const incoming = !!mv.toLocationId && !mv.fromLocationId;
    const outgoing = !!mv.fromLocationId && !mv.toLocationId;
    if (incoming || outgoing) {
      const item = await tx.item.findUniqueOrThrow({ where: { id: mv.itemId } });
      const cur = await itemQty(tx, mv.itemId);
      const avg = Number(item.avgCost);
      const next = incoming ? avgAfterRemoval(cur, avg, qty, unitCost) : avgAfterReturn(cur, avg, qty, unitCost);
      if (next !== avg) await tx.item.update({ where: { id: item.id }, data: { avgCost: BigInt(next) } });
    }
    await tx.stockMovement.create({
      data: { date: new Date(), type: "PENYESUAIAN", itemId: mv.itemId, fromLocationId: mv.toLocationId, toLocationId: mv.fromLocationId, qty: mv.qty, unitCost: mv.unitCost, ref: reversalRef, note, createdBy: actor.name },
    });
  }
  return moves.length;
}

/** Hapus entri produksi: balik mutasi stok (termasuk harga rata-rata) & jurnal terkait (jejak tetap tersimpan). */
export async function reverseProductionStock(tx: Tx, entryId: string, actor: Actor) {
  await reverseMovementsByRef(tx, `PRD:${entryId}`, `BATAL-PRD:${entryId}`, "Pembatalan entri produksi", actor);
  const journals = await tx.journal.findMany({ where: { source: "PRODUKSI", sourceId: entryId, reversalOfId: null } });
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
