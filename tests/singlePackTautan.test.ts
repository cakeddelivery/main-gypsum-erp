import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { applySinglePackLinks, planSinglePackLinks } from "@/lib/singlePackFix";

class Rollback extends Error {}
const tag = Date.now().toString(36).slice(-5).toUpperCase();

/** Semua dalam transaksi yang dibatalkan: data uji lain tidak tersentuh */
async function inRollback(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>) {
  await prisma
    .$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

async function scenario(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) {
  const store = await tx.store.findFirstOrThrow();
  const div = await tx.division.findFirstOrThrow();
  void div;
  // kosongkan tautan COWOK yang ada (hanya di dalam transaksi uji)
  await tx.product.updateMany({ where: { type: "SATUAN", variant: "COWOK" }, data: { finishedItemId: null, active: false } });
  await tx.item.updateMany({ where: { sku: "BJ-SAT-COWOK" }, data: { sku: `OLD-${tag}` } }); // data uji lain, hanya di transaksi ini
  let fam = await tx.productFamily.findFirst({ where: { name: "Satuan Single Pack" } });
  fam ??= await tx.productFamily.create({ data: { code: `IND-T${tag}`, name: "Satuan Single Pack", type: "SATUAN" } });
  await tx.product.updateMany({ where: { familyId: fam.id, variant: "COWOK" }, data: { familyId: null } });
  const mk = (sku: string) => tx.item.create({ data: { sku, name: `Barang ${sku}`, type: "BARANG_JADI", unit: "pcs" } });
  const itemLegacy = await mk(`TL-${tag}`); // barang yang dipakai laporan (produk lama, urut kode paling awal)
  const itemCat = await mk(`TC-${tag}`); // barang produk katalog (salah)
  const legacy = await tx.product.create({ data: { sku: `AAA-${tag}`, name: "Satuan Cowok lama", type: "SATUAN", variant: "COWOK", storeId: store.id, finishedItemId: itemLegacy.id } });
  const cat = await tx.product.create({ data: { sku: `ZZZ-${tag}`, name: "Satuan Single Pack Cowok", type: "SATUAN", variant: "COWOK", storeId: store.id, finishedItemId: itemCat.id, familyId: fam.id } });
  await tx.stockMovement.create({ data: { type: "HASIL_PRODUKSI", itemId: itemLegacy.id, qty: 5, createdBy: "t", ref: `LPH:uji${tag}:1` } }); // riwayat laporan shift ada di barang lama
  return { legacy, cat, itemLegacy, itemCat, fam };
}

describe("Tautan barang Satuan Single Pack ke katalog", () => {
  it("barang laporan tidak ada di katalog → pratinjau 'move'; setelah diterapkan tampil di grup katalog", async () => {
    await inRollback(async (tx) => {
      const s = await scenario(tx);
      const plans = await planSinglePackLinks(tx);
      const p = plans.find((x) => x.variant === "COWOK")!;
      expect(p.action).toBe("move");
      expect(p.duplicates.length).toBeGreaterThanOrEqual(2);
      // pratinjau murni: tidak mengubah
      expect((await tx.product.findUniqueOrThrow({ where: { id: s.cat.id } })).finishedItemId).toBe(s.itemCat.id);
      await applySinglePackLinks(tx, plans);
      expect((await tx.product.findUniqueOrThrow({ where: { id: s.cat.id } })).finishedItemId).toBe(s.itemLegacy.id);
      expect((await tx.product.findUniqueOrThrow({ where: { id: s.legacy.id } })).finishedItemId).toBeNull(); // dilepas dari produk lama
      expect(await tx.item.count({ where: { id: s.itemCat.id } })).toBe(1); // barang lama tidak dihapus
      // diulang: sudah benar, tidak ada perubahan
      expect((await planSinglePackLinks(tx)).find((x) => x.variant === "COWOK")!.action).toBe("ok");
    });
  });

  it("produk katalog tanpa barang → 'link' ke barang laporan", async () => {
    await inRollback(async (tx) => {
      const s = await scenario(tx);
      await tx.product.update({ where: { id: s.legacy.id }, data: { finishedItemId: null, active: false } });
      await tx.product.update({ where: { id: s.cat.id }, data: { finishedItemId: null } });
      const item = (await tx.item.findUnique({ where: { sku: "BJ-SAT-COWOK" } })) ?? (await tx.item.create({ data: { sku: "BJ-SAT-COWOK", name: "Patung satuan Cowok", type: "BARANG_JADI", unit: "pcs" } }));
      await tx.stockMovement.create({ data: { type: "HASIL_PRODUKSI", itemId: item.id, qty: 3, createdBy: "t", ref: `LPH:uji${tag}:2` } });
      const p = (await planSinglePackLinks(tx)).find((x) => x.variant === "COWOK")!;
      expect(p.action).toBe("link");
      await applySinglePackLinks(tx, [p]);
      expect((await tx.product.findUniqueOrThrow({ where: { id: s.cat.id } })).finishedItemId).toBe(item.id);
    });
  });
});
