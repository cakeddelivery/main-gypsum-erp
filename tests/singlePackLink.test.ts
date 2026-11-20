import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CATALOG, SATUAN_FAMILY, ensureFamily } from "@/lib/productFamily";
import { applySinglePackLinks, isSinglePackName, planSinglePackLinks } from "@/lib/singlePackLink";
import { resultPlaces } from "@/lib/resultCountGroups";

const tag = `SPL${Date.now().toString(36).toUpperCase()}`;

describe("Nama barang Single Pack", () => {
  it("cocok per varian, bukan paket / satuan katalog", () => {
    expect(isSinglePackName("Hewan", "Single Pack Hewan")).toBe(true);
    expect(isSinglePackName("HEWAN", "single pack hewan")).toBe(true);
    expect(isSinglePackName("Transportasi", "Single Pack Transport")).toBe(true);
    expect(isSinglePackName("TRANSPORTASI", "Single Pack Transportasi")).toBe(true);
    expect(isSinglePackName("Cowok", "Single Pack Cewek")).toBe(false);
    expect(isSinglePackName("Hewan", "Paket Single Pack 12 pcs · Hewan")).toBe(false);
    expect(isSinglePackName("Hewan", "Satuan Single Pack · Hewan")).toBe(false);
  });
});

describe("Tautan Satuan Single Pack → barang Single Pack (grup Stok jadi)", () => {
  const made: string[] = [];
  const deactivated: string[] = [];
  let productId = "";
  let createdProduct = false;
  let originalItemId: string | null = null;
  let wrongId = "";
  let spId = "";
  const item = async (name: string) => {
    const it = await prisma.item.create({ data: { sku: `${tag}-${made.length}`, name, unit: "pcs", type: "BARANG_JADI" } });
    made.push(it.id);
    return it.id;
  };
  const hewan = () => planSinglePackLinks(prisma).then((xs) => xs.find((x) => x.variant === "Hewan")!);

  beforeAll(async () => {
    const f = await ensureFamily(prisma, CATALOG.find((c) => c.name === SATUAN_FAMILY)!);
    // Barang "Single Pack Hewan" milik tes lain dinonaktifkan sementara agar tes terisolasi
    const others = (await prisma.item.findMany({ where: { active: true, name: { contains: "single", mode: "insensitive" } } })).filter((i) => isSinglePackName("Hewan", i.name));
    for (const o of others) await prisma.item.update({ where: { id: o.id }, data: { active: false } });
    deactivated.push(...others.map((o) => o.id));
    wrongId = await item(`Satuan Single Pack · Hewan ${tag}`);
    const existing = await prisma.product.findFirst({ where: { familyId: f.id, variant: "HEWAN" } });
    if (existing) {
      productId = existing.id;
      originalItemId = existing.finishedItemId;
      await prisma.product.update({ where: { id: existing.id }, data: { finishedItemId: wrongId } });
    } else {
      const opt = f.axes.flatMap((a) => a.options).find((o) => o.name === "Hewan")!;
      const store = await prisma.store.findFirstOrThrow();
      const p = await prisma.product.create({ data: { sku: `${tag}-P`, name: `Satuan Single Pack · Hewan ${tag}`, type: "SATUAN", variant: "HEWAN", packQty: 1, storeId: store.id, finishedItemId: wrongId, familyId: f.id, variantValues: { create: [{ optionId: opt.id }] } } });
      productId = p.id;
      createdProduct = true;
    }
    spId = await item("Single Pack Hewan");
  });

  afterAll(async () => {
    if (createdProduct) {
      await prisma.productVariantValue.deleteMany({ where: { productId } });
      await prisma.product.delete({ where: { id: productId } });
    } else await prisma.product.update({ where: { id: productId }, data: { finishedItemId: originalItemId } });
    await prisma.item.deleteMany({ where: { id: { in: made } } });
    if (deactivated.length) await prisma.item.updateMany({ where: { id: { in: deactivated } }, data: { active: true } });
  });

  it("pratinjau tidak mengubah; --jalankan menautkan → Single Pack Hewan masuk grup Satuan Single Pack", async () => {
    expect((await resultPlaces([{ id: spId, type: "BARANG_JADI" }])).get(spId)?.group).toBe("Produk jadi lainnya");
    const plan = await hewan();
    expect(plan.status).toBe("tautkan");
    expect(plan.itemId).toBe(spId);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).finishedItemId).toBe(wrongId);

    expect(await applySinglePackLinks(prisma, [plan])).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).finishedItemId).toBe(spId);
    const place = (await resultPlaces([{ id: spId, type: "BARANG_JADI" }])).get(spId);
    expect(place?.group).toBe(SATUAN_FAMILY);
    expect(place?.col).toBe("Hewan");
    // Barang lama tidak dihapus
    expect(await prisma.item.findUnique({ where: { id: wrongId } })).not.toBeNull();
    expect((await hewan()).status).toBe("ok");
  });

  it("barang Single Pack ganda hanya dilaporkan, tidak ditautkan", async () => {
    await prisma.product.update({ where: { id: productId }, data: { finishedItemId: wrongId } });
    await item("Single Pack Hewan");
    const plan = await hewan();
    expect(plan.status).toBe("ganda");
    expect(plan.text).toMatch(/GANDA/);
    expect(await applySinglePackLinks(prisma, [plan])).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).finishedItemId).toBe(wrongId);
  });
});
