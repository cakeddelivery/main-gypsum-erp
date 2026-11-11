import type { ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { COA, postJournal, type LineInput } from "./accounting";
import { INVENTORY_COA, StockError, itemQty, lockItems, locationSettings, qtyAt, recordMovement } from "./stock";

type Actor = { id: string; name: string };
export type OpeningRow = { itemId: string; physical: number; unitCost?: number | null };

/** Setting: tanggal stok awal riil terakhir disimpan */
export const OPENING_SETTING = "stok_awal_tanggal";

/**
 * Stok awal riil (hitung fisik semua gudang, sekali sebelum sakelar "Hasil kerja → stok" dinyalakan):
 * - Stok sistem di gudang sesuai jenis barang (bahan baku / setengah jadi / barang jadi) disamakan dengan hitungan fisik.
 * - Harga per satuan boleh diisi (mis. barang yang belum pernah punya harga); kosong = harga rata-rata sekarang.
 * - Selisih nilai dibukukan ke Ekuitas Saldo Awal (bukan laba rugi), karena ini pencatatan awal aset, bukan pemakaian.
 * Barang yang sedang di titik borongan / driver tidak diubah.
 */
export async function saveOpeningStock(rows: OpeningRow[], date: Date, actor: Actor) {
  const list = rows.filter((r) => r.itemId && Number.isFinite(r.physical));
  if (!list.length) throw new StockError("Isi minimal satu hitungan fisik");
  if (list.some((r) => r.physical < 0 || (r.unitCost != null && r.unitCost < 0))) throw new StockError("Jumlah / harga tidak boleh minus");
  return prisma.$transaction(async (tx) => {
    const locs = await locationSettings(tx);
    const store = (await tx.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
    if (!store) throw new StockError("Toko default belum diatur di Pengaturan");
    await lockItems(tx, list.map((r) => r.itemId));
    const ref = `AWAL-${date.toISOString().slice(0, 10)}`;
    const delta: Record<ItemType, number> = { BAHAN_BAKU: 0, BARANG_DALAM_PROSES: 0, BARANG_JADI: 0 };
    let changed = 0;
    for (const r of list) {
      const item = await tx.item.findUniqueOrThrow({ where: { id: r.itemId } });
      const loc = item.type === "BAHAN_BAKU" ? locs.raw : item.type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
      if (!loc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
      const sys = await qtyAt(tx, item.id, loc);
      const total = await itemQty(tx, item.id);
      const oldAvg = Number(item.avgCost);
      const newAvg = r.unitCost != null && r.unitCost > 0 ? Math.round(r.unitCost) : oldAvg;
      const diff = Math.round((r.physical - sys) * 1000) / 1000;
      if (diff === 0 && newAvg === oldAvg) continue;
      if (diff !== 0) {
        await recordMovement(tx, { type: "PENYESUAIAN", itemId: item.id, qty: Math.abs(diff), fromLocationId: loc, increase: diff > 0, allowNegative: true, noJournal: true, ref, note: `Stok awal (hitung fisik): sistem ${sys}, fisik ${r.physical}`, date }, actor);
      }
      if (newAvg !== oldAvg) await tx.item.update({ where: { id: item.id }, data: { avgCost: BigInt(newAvg) } });
      delta[item.type] += Math.round(Math.max(0, total + diff) * newAvg - Math.max(0, total) * oldAvg);
      changed++;
    }
    const lines: LineInput[] = (Object.keys(delta) as ItemType[]).filter((t) => delta[t] !== 0).flatMap((t): LineInput[] =>
      delta[t] > 0
        ? [{ accountCode: INVENTORY_COA[t], debit: delta[t] }, { accountCode: COA.EKUITAS_SALDO_AWAL, credit: delta[t] }]
        : [{ accountCode: COA.EKUITAS_SALDO_AWAL, debit: -delta[t] }, { accountCode: INVENTORY_COA[t], credit: -delta[t] }],
    );
    if (lines.length) await postJournal(tx, { date, storeId: store, description: `Stok awal riil (hitung fisik) ${ref}`, source: "STOK_AWAL", sourceId: ref, actor, lines });
    await tx.setting.upsert({ where: { key: OPENING_SETTING }, create: { key: OPENING_SETTING, value: date.toISOString() }, update: { value: date.toISOString() } });
    await audit(actor, "STOK_AWAL", "StockMovement", null, { ref, items: changed, delta }, tx);
    return { changed, delta };
  }, { timeout: 120000 });
}
