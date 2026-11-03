import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { saveItemRecord } from "@/lib/items";
import { itemCategories } from "@/lib/itemCategories";

describe("Kategori produk dari Pengaturan", () => {
  it("kategori baru dipakai untuk validasi & awalan kode item baru", async () => {
    const actor = { id: "system", name: "uji" };
    await expect(saveItemRecord({ name: "Mainan Puzzle Uji", type: "BARANG_JADI", category: "Mainan Edukasi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor)).rejects.toThrow(/Kategori/);
    await prisma.itemCategory.create({ data: { type: "BARANG_JADI", name: "Mainan Edukasi", prefix: "ME", sortOrder: 2 } });
    expect((await itemCategories()).BARANG_JADI.map((c) => c.name)).toContain("Mainan Edukasi");
    const it1 = await saveItemRecord({ name: "Mainan Puzzle Uji", type: "BARANG_JADI", category: "Mainan Edukasi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor);
    expect(it1.sku).toMatch(/^ME-\d{3}$/);
    // Nonaktif: tidak muncul di pilihan, tapi item lama tetap valid
    await prisma.itemCategory.update({ where: { prefix: "ME" }, data: { active: false } });
    expect((await itemCategories()).BARANG_JADI.map((c) => c.name)).not.toContain("Mainan Edukasi");
    await expect(saveItemRecord({ id: it1.id, sku: it1.sku, name: it1.name, type: "BARANG_JADI", category: "Mainan Edukasi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor)).resolves.toBeTruthy();
  });
});
