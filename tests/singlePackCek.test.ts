import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { diagLines, diagnoseSinglePack, isSinglePackCandidate } from "@/lib/singlePackDiag";

const tag = `SPC${Date.now().toString(36).toUpperCase()}`;

describe("Kandidat barang Single Pack", () => {
  it("kode BJ-SAT-/SJ-SP- dan nama single pack/satuan per series; bukan paket/giftbox", () => {
    expect(isSinglePackCandidate("HEWAN", { sku: "BJ-SAT-HEWAN", name: "Satuan Single Pack · Hewan" })).toBe(true);
    expect(isSinglePackCandidate("HEWAN", { sku: "SJ-SP-HEWAN", name: "x" })).toBe(true);
    expect(isSinglePackCandidate("COWOK", { sku: "MG-010", name: "Single Pack Cowok" })).toBe(true);
    expect(isSinglePackCandidate("TRANSPORTASI", { sku: "MG-064", name: "Single Pack Transportasi" })).toBe(true);
    expect(isSinglePackCandidate("CEWEK", { sku: "MG-011", name: "Single Pack Cowok" })).toBe(false);
    expect(isSinglePackCandidate("HEWAN", { sku: "MG-020", name: "Paket Single Pack 12 pcs · Hewan" })).toBe(false);
  });
});

describe("Diagnosa single-pack:cek (read-only)", () => {
  const ids: { items: string[]; product?: string } = { items: [] };
  beforeAll(async () => {
    const div = await prisma.division.findFirstOrThrow();
    const a = await prisma.item.create({ data: { sku: `${tag}-A`, name: `Single Pack Hewan ${tag}`, unit: "pcs", type: "BARANG_DALAM_PROSES", divisionId: div.id } });
    const b = await prisma.item.create({ data: { sku: `${tag}-B`, name: `Patung satuan Hewan ${tag}`, unit: "pcs", type: "BARANG_JADI" } });
    ids.items.push(a.id, b.id);
    const store = await prisma.store.findFirstOrThrow();
    ids.product = (await prisma.product.create({ data: { sku: `${tag}-P`, name: `Satuan Hewan ${tag}`, type: "SATUAN", variant: "HEWAN", packQty: 1, storeId: store.id, finishedItemId: b.id } })).id;
  });
  afterAll(async () => {
    if (ids.product) await prisma.product.delete({ where: { id: ids.product } });
    await prisma.item.deleteMany({ where: { id: { in: ids.items } } });
  });

  it("menampilkan semua barang kandidat per series beserta pemakaiannya, tanpa mengubah data", async () => {
    const before = await prisma.item.count();
    const d = await diagnoseSinglePack();
    expect(await prisma.item.count()).toBe(before);
    expect(d.map((x) => x.variant)).toEqual(["HEWAN", "COWOK", "CEWEK", "TRANSPORTASI"]);
    const hewan = d.find((x) => x.variant === "HEWAN")!;
    const a = hewan.items.find((i) => i.sku === `${tag}-A`)!;
    const b = hewan.items.find((i) => i.sku === `${tag}-B`)!;
    expect(a.division).toBeTruthy();
    expect(a.usedBy).toEqual([]);
    expect(b.usedBy.some((u) => u.includes(`produk ${tag}-P`))).toBe(true);
    expect(diagLines(d).join("\n")).toMatch(/LEBIH DARI SATU/);
  });
});
