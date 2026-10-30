import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { COA, postJournal } from "./accounting";
import { audit } from "./audit";
import { INVENTORY_COA, StockError, locationSettings, recordMovement } from "./stock";
import { ITEM_CATEGORIES, categoryPrefix } from "./itemCatalog";

export * from "./itemCatalog";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Kode item berikutnya per awalan, mis. BU-001; melewati kode yang sudah dipakai manual */
export async function nextItemSku(tx: Tx, prefix: string) {
  for (;;) {
    const rows = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO "Counter"("key","value") VALUES (${`SKU-${prefix}`}, 1)
      ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
      RETURNING "value"`;
    const sku = `${prefix}-${String(rows[0].value).padStart(3, "0")}`;
    if (!(await tx.item.findUnique({ where: { sku } }))) return sku;
  }
}

export type ItemInput = {
  id?: string | null;
  sku?: string | null;
  name: string;
  type: ItemType;
  category?: string | null;
  unit: string;
  hppUnit?: string | null;
  hppFactor: number;
  minStock: number;
  supplierId?: string | null;
  /** Supplier baru yang diketik langsung di form (dibuat bila supplierId kosong) */
  newSupplierName?: string | null;
  gypsumCharacterId?: string | null;
  divisionId?: string | null;
  note?: string | null;
  active?: boolean;
  /** Item baru: harga beli per satuan beli & stok awal (dalam satuan beli) */
  price?: number;
  openingQty?: number;
};

/**
 * Simpan master item. Item baru tanpa kode mendapat kode otomatis per kategori.
 * Stok awal masuk ke lokasi sesuai jenisnya; nilainya dibukukan Dr Persediaan / Cr Ekuitas Saldo Awal.
 */
export async function saveItemRecord(input: ItemInput, actor: Actor) {
  const name = input.name.trim();
  if (name.length < 2) throw new StockError("Nama minimal 2 huruf");
  if (!(input.hppFactor > 0)) throw new StockError("Isi per satuan beli harus lebih dari 0");
  if (input.category && !ITEM_CATEGORIES[input.type].some((c) => c.name === input.category)) throw new StockError("Kategori tidak sesuai jenis item");
  const price = Math.round(input.price ?? 0);
  const openingQty = input.openingQty ?? 0;
  if (price < 0 || openingQty < 0) throw new StockError("Harga dan stok awal tidak boleh minus");
  const unit = input.unit.trim() || "pcs";
  const hppUnit = input.hppUnit?.trim() && input.hppUnit.trim() !== unit ? input.hppUnit.trim() : null;

  return prisma.$transaction(async (tx) => {
    let supplierId = input.supplierId || null;
    const newSupplier = input.newSupplierName?.trim();
    if (!supplierId && newSupplier) {
      const existing = await tx.supplier.findFirst({ where: { name: { equals: newSupplier, mode: "insensitive" } } });
      supplierId = existing?.id ?? (await tx.supplier.create({ data: { name: newSupplier } })).id;
    }
    const data = {
      name,
      type: input.type,
      category: input.category || null,
      unit,
      hppUnit,
      hppFactor: hppUnit ? input.hppFactor : 1,
      minStock: input.minStock,
      supplierId,
      gypsumCharacterId: input.gypsumCharacterId || null,
      divisionId: input.divisionId || null,
      note: input.note?.trim() || null,
    };
    if (input.id) {
      const sku = input.sku?.trim().toUpperCase();
      if (!sku || sku.length < 2) throw new StockError("Kode item wajib diisi");
      const it = await tx.item.update({ where: { id: input.id }, data: { ...data, sku, active: input.active ?? true } });
      await audit(actor, "ITEM_DIUBAH", "Item", it.id, data, tx);
      return it;
    }
    const sku = input.sku?.trim().toUpperCase() || (await nextItemSku(tx, categoryPrefix(input.type, input.category)));
    const it = await tx.item.create({ data: { ...data, sku, avgCost: BigInt(price), lastCost: BigInt(price), lastCostAt: price > 0 ? new Date() : null } });
    if (openingQty > 0) {
      const locs = await locationSettings(tx);
      const loc = input.type === "BAHAN_BAKU" ? locs.raw : input.type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
      if (!loc) throw new StockError("Lokasi gudang untuk jenis item ini belum diatur di Pengaturan");
      const mv = await recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: openingQty, toLocationId: loc, unitCost: price, ref: `SALDO-AWAL:${sku}`, note: "Stok awal" }, actor);
      const value = Math.round(openingQty * price);
      if (value > 0) {
        const store = await tx.setting.findUnique({ where: { key: "default_store_id" } });
        if (!store) throw new StockError("Toko default belum diatur di Pengaturan");
        const j = await postJournal(tx, {
          date: mv.date,
          storeId: store.value,
          description: `Stok awal ${sku} ${name} × ${openingQty}`,
          source: "SALDO_AWAL",
          sourceId: mv.id,
          actor,
          lines: [{ accountCode: INVENTORY_COA[input.type], debit: value }, { accountCode: COA.EKUITAS_SALDO_AWAL, credit: value }],
        });
        await tx.stockMovement.update({ where: { id: mv.id }, data: { journalId: j.id } });
      }
    }
    await audit(actor, "ITEM_DIBUAT", "Item", it.id, { ...data, sku, price, openingQty }, tx);
    return it;
  });
}
