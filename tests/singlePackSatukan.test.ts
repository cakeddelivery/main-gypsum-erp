import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MERGE_REF, applySinglePackMerge, isSinglePackItemName, planSinglePackMerge } from "@/lib/singlePackMerge";
import { flowItem } from "@/lib/shiftReportFlow";
import { resultPlaces } from "@/lib/resultCountGroups";
import { diagnoseSinglePack, isSinglePackCandidate } from "@/lib/singlePackDiag";
import { qtyAt } from "@/lib/stock";
import { skuKey } from "@/lib/returnLabel";

class Rollback extends Error {}
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const actor = { id: "uji", name: "Uji satukan" };

/** Semua di dalam transaksi yang dibatalkan: data uji lain tidak tersentuh */
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
}

/** Keadaan production: katalog COWOK → BJ-SAT-COWOK (akibat #151); "Single Pack Cowok" (Packing) dipakai BOM/resep/borongan; dua-duanya minus */
async function scenario(tx: Prisma.TransactionClient, avg: { s: number; t: number }) {
  const store = await tx.store.findFirstOrThrow();
  const loc = await tx.location.findFirstOrThrow();
  await tx.item.updateMany({ where: { sku: "BJ-SAT-COWOK" }, data: { sku: `OLD-${tag}`, active: false } });
  // Barang Cowok dari tes lain dinonaktifkan (hanya di transaksi ini) agar diagnosa terisolasi
  const others = (await tx.item.findMany({ where: { active: true } })).filter((i) => isSinglePackItemName("COWOK", i.name) || isSinglePackCandidate("COWOK", i));
  await tx.item.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: false } });
  await tx.product.updateMany({ where: { type: "SATUAN", variant: "COWOK" }, data: { familyId: null, active: false } });
  let fam = await tx.productFamily.findFirst({ where: { name: "Satuan Single Pack" } });
  fam ??= await tx.productFamily.create({ data: { code: `IND-S${tag}`, name: "Satuan Single Pack", type: "SATUAN" } });
  const axis = (await tx.variantAxis.findFirst({ where: { familyId: fam.id } })) ?? (await tx.variantAxis.create({ data: { familyId: fam.id, name: "Series" } }));
  const opt = (await tx.variantOption.findFirst({ where: { axisId: axis.id, name: "Cowok" } })) ?? (await tx.variantOption.create({ data: { axisId: axis.id, name: "Cowok", variant: "COWOK" } }));
  const packing = await tx.division.findFirstOrThrow();
  const S = await tx.item.create({ data: { sku: "BJ-SAT-COWOK", name: "Patung satuan Cowok", type: "BARANG_JADI", unit: "pcs", avgCost: BigInt(avg.s) } });
  const T = await tx.item.create({ data: { sku: `MG-T${tag}`, name: "Single Pack Cowok", type: "BARANG_JADI", unit: "pcs", divisionId: packing.id, avgCost: BigInt(avg.t) } });
  const cat = await tx.product.create({ data: { sku: `MG-P${tag}`, name: "Satuan Single Pack · Cowok", type: "SATUAN", variant: "COWOK", packQty: 1, storeId: store.id, finishedItemId: S.id, familyId: fam.id, variantValues: { create: [{ optionId: opt.id }] } } });
  await tx.stockMovement.create({ data: { type: "PENGELUARAN", itemId: S.id, fromLocationId: loc.id, qty: 7, createdBy: "t", ref: `LPH:uji${tag}:1` } });
  await tx.stockMovement.create({ data: { type: "PENGELUARAN", itemId: T.id, fromLocationId: loc.id, qty: 3, createdBy: "t", ref: `LPH:uji${tag}:2` } });
  const paket = await tx.product.create({ data: { sku: `PK-${tag}`, name: "Paket uji", type: "PAKET_12", variant: "COWOK", packQty: 12, storeId: store.id } });
  await tx.bomLine.create({ data: { productId: paket.id, itemId: S.id, qty: 12 } });
  await tx.marketplaceSkuMap.create({ data: { key: `UJI-${tag}|`, itemId: S.id, updatedBy: "t" } });
  return { S, T, cat, loc, paket };
}

describe("single-pack:satukan — satu barang per series (pola Transportasi)", () => {
  it("pratinjau → jalankan: katalog & flowItem ke Single Pack, saldo dipindah tanpa jurnal, pemetaan dialihkan, BJ-SAT nonaktif", async () => {
    await inRollback(async (tx) => {
      const { S, T, cat, loc, paket } = await scenario(tx, { s: 1000, t: 1000 });
      const plan = (await planSinglePackMerge(tx)).find((p) => p.variant === "COWOK")!;
      expect(plan.action).toBe("satukan");
      expect(plan.sameValue).toBe(true);
      expect(plan.moves).toEqual([{ locationId: loc.id, location: loc.name, qty: -7 }]);
      expect(plan.lines.join("\n")).toMatch(/TANPA jurnal/);
      // pratinjau tidak mengubah
      expect((await tx.product.findUniqueOrThrow({ where: { id: cat.id } })).finishedItemId).toBe(S.id);

      expect(await applySinglePackMerge(tx, [plan], actor)).toBe(1);
      expect((await tx.product.findUniqueOrThrow({ where: { id: cat.id } })).finishedItemId).toBe(T.id);
      expect(await flowItem(tx, { kind: "jadi", key: "Cowok" })).toBe(T.id);
      expect((await resultPlaces([{ id: T.id, type: "BARANG_JADI" }], tx)).get(T.id)?.group).toBe("Satuan Single Pack");
      expect(await qtyAt(tx, S.id, loc.id)).toBe(0);
      expect(await qtyAt(tx, T.id, loc.id)).toBe(-10);
      const moves = await tx.stockMovement.findMany({ where: { ref: MERGE_REF, itemId: { in: [S.id, T.id] } } });
      expect(moves).toHaveLength(2);
      expect(moves.every((m) => m.type === "PENYESUAIAN" && m.journalId === null)).toBe(true);
      // riwayat lama tetap
      expect(await tx.stockMovement.count({ where: { itemId: S.id, ref: `LPH:uji${tag}:1` } })).toBe(1);
      expect((await tx.bomLine.findFirstOrThrow({ where: { productId: paket.id } })).itemId).toBe(T.id);
      expect((await tx.marketplaceSkuMap.findUniqueOrThrow({ where: { key: `UJI-${tag}|` } })).itemId).toBe(T.id);
      expect((await tx.marketplaceSkuMap.findUniqueOrThrow({ where: { key: skuKey("BJ-SAT-COWOK", "") } })).itemId).toBe(T.id);
      const s = await tx.item.findUniqueOrThrow({ where: { id: S.id } });
      expect(s.active).toBe(false);
      expect(s.note).toMatch(/digabung ke/);
      expect((await tx.item.findUniqueOrThrow({ where: { id: T.id } })).note).toMatch(/BJ-SAT-COWOK/);
      // ulang → sudah satu barang; diagnosa menunjukkan 1 barang aktif
      expect((await planSinglePackMerge(tx)).find((p) => p.variant === "COWOK")!.action).toBe("ok");
      const d = (await diagnoseSinglePack(tx)).find((x) => x.variant === "COWOK")!;
      expect(d.items.map((i) => i.id)).toEqual([T.id]);
      expect(d.flowItemId).toBe(T.id);
    });
  });

  it("nilai rata-rata beda → ditampilkan di pratinjau dan dijurnal (selisih ke Beban Selisih Persediaan)", async () => {
    await inRollback(async (tx) => {
      const { S, T } = await scenario(tx, { s: 1000, t: 1500 });
      const plan = (await planSinglePackMerge(tx)).find((p) => p.variant === "COWOK")!;
      expect(plan.sameValue).toBe(false);
      expect(plan.lines.join("\n")).toMatch(/BEDA/);
      await applySinglePackMerge(tx, [plan], actor);
      const moves = await tx.stockMovement.findMany({ where: { ref: MERGE_REF, itemId: { in: [S.id, T.id] } } });
      expect(moves.every((m) => m.journalId !== null)).toBe(true);
    });
  });

  it("barang Single Pack ganda → skip, tidak diubah", async () => {
    await inRollback(async (tx) => {
      const { S, cat } = await scenario(tx, { s: 0, t: 0 });
      await tx.item.create({ data: { sku: `MG-D${tag}`, name: "Single Pack Cowok", type: "BARANG_JADI", unit: "pcs" } });
      const plan = (await planSinglePackMerge(tx)).find((p) => p.variant === "COWOK")!;
      expect(plan.action).toBe("skip");
      expect(await applySinglePackMerge(tx, [plan], actor)).toBe(0);
      expect((await tx.product.findUniqueOrThrow({ where: { id: cat.id } })).finishedItemId).toBe(S.id);
    });
  });
});
