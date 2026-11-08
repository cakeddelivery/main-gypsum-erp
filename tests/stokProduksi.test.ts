import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { avgAfterRemoval, avgAfterReturn, itemQty, locationSettings, postProductionStock, qtyAt, recordMovement } from "@/lib/stock";
import { deleteProductionEntry } from "@/lib/productionEntry";
import { recordResults, savePerson, type Scope } from "@/lib/borongan";
import { dateOnly } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
let locs: Awaited<ReturnType<typeof locationSettings>>;
let base: { shiftId: string; divisionId: string; employeeId: string; createdBy: string };
const all: Scope = { all: true, pointIds: [], personId: null };
const avg = async (id: string) => Number((await prisma.item.findUniqueOrThrow({ where: { id } })).avgCost);
const receive = (itemId: string, qty: number, unitCost: number, toLocationId: string) => prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId, qty, toLocationId, unitCost }, actor));

/** Produk uji dengan 1 bahan (1 pcs bahan per produk) dan barang jadinya sendiri */
async function makeProduct(tag: string) {
  const bahan = await prisma.item.create({ data: { sku: `BB-RA-${tag}`, name: `Bahan R3 ${tag}`, type: "BAHAN_BAKU", unit: "pcs" } });
  const jadi = await prisma.item.create({ data: { sku: `BJ-RA-${tag}`, name: `Jadi R3 ${tag}`, type: "BARANG_JADI", unit: "pcs" } });
  const product = await prisma.product.create({ data: { sku: `PR-RA-${tag}`, name: `Produk R3 ${tag}`, type: "SATUAN", variant: "MIX", storeId, finishedItemId: jadi.id, bom: { create: [{ itemId: bahan.id, qty: 1 }] } } });
  return { bahan, jadi, product };
}

async function produce(productId: string, stage: "CETAK" | "BARANG_JADI", qtyGood: number) {
  const e = await prisma.productionEntry.create({ data: { ...base, date: dateOnly("2027-06-10"), productId, stage, qtyGood, qtyReject: 0 } });
  await prisma.$transaction((tx) => postProductionStock(tx, e.id, actor));
  return e;
}

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  locs = await locationSettings(prisma);
  const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
  const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
  base = { shiftId: shift.id, divisionId: emp.divisionId!, employeeId: emp.id, createdBy: "uji" };
});

describe("R3: hapus produksi mengembalikan harga pokok rata-rata", () => {
  it("rumus kebalikan rata-rata bergerak", () => {
    // 10 @3000 + 10 @5000 = rata-rata 4000; keluarkan 10 @5000 → kembali 3000
    expect(avgAfterRemoval(20, 4000, 10, 5000)).toBe(3000);
    // stok habis: harga terakhir dipertahankan
    expect(avgAfterRemoval(10, 5000, 10, 5000)).toBe(5000);
    expect(avgAfterReturn(0, 0, 5, 1200)).toBe(1200);
    expect(avgAfterReturn(10, 1000, 10, 3000)).toBe(2000);
  });

  it("hasil barang jadi dihapus → avgCost & stok barang jadi kembali seperti sebelum produksi", async () => {
    const { bahan, jadi, product } = await makeProduct("BJ");
    await receive(bahan.id, 100, 5000, locs.raw!);
    await receive(jadi.id, 10, 3000, locs.finished!);
    expect(await avg(jadi.id)).toBe(3000);
    const e = await produce(product.id, "BARANG_JADI", 10); // nilai bahan 5000/pcs
    expect(await avg(jadi.id)).toBe(4000);
    expect(await itemQty(prisma, jadi.id)).toBe(20);

    await deleteProductionEntry(e.id, actor);
    expect(await avg(jadi.id)).toBe(3000);
    expect(await itemQty(prisma, jadi.id)).toBe(10);
    expect(await prisma.productionEntry.findUnique({ where: { id: e.id } })).toBeNull();
    // Jurnal produksi sudah dibalik semua (saldo bersih 0)
    const orig = await prisma.journal.findMany({ where: { source: "PRODUKSI", sourceId: e.id } });
    const js = await prisma.journal.findMany({ where: { OR: [{ id: { in: orig.map((j) => j.id) } }, { reversalOfId: { in: orig.map((j) => j.id) } }] }, include: { lines: true } });
    const net = js.flatMap((j) => j.lines).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(js.length).toBeGreaterThanOrEqual(2);
    expect(net).toBe(0);
  });

  it("konsumsi bahan Cetak dihapus setelah ada pembelian baru → avgCost sama seperti bila produksi tidak pernah ada", async () => {
    const { bahan, product } = await makeProduct("CT");
    await receive(bahan.id, 100, 5000, locs.raw!);
    const e = await produce(product.id, "CETAK", 10); // 10 bahan keluar @5000
    await receive(bahan.id, 10, 8000, locs.raw!); // (90×5000 + 10×8000) / 100 = 5300
    expect(await avg(bahan.id)).toBe(5300);
    await deleteProductionEntry(e.id, actor);
    // tanpa produksi: (100×5000 + 10×8000) / 110 = 5272,7
    expect(await avg(bahan.id)).toBe(5273);
    expect(await qtyAt(prisma, bahan.id, locs.raw!)).toBe(110);
  });

  it("hapus dua kali bersamaan hanya membalik stok sekali", async () => {
    const { bahan, jadi, product } = await makeProduct("DBL");
    await receive(bahan.id, 50, 2000, locs.raw!);
    const e = await produce(product.id, "BARANG_JADI", 5);
    const res = await Promise.allSettled([deleteProductionEntry(e.id, actor), deleteProductionEntry(e.id, actor)]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await itemQty(prisma, jadi.id)).toBe(0);
    expect(await prisma.stockMovement.count({ where: { ref: `BATAL-PRD:${e.id}` } })).toBe(1);
  });
});

describe("R4: stok aman dari permintaan bersamaan", () => {
  it("dua pengeluaran bersamaan tidak membuat stok minus diam-diam", async () => {
    const it = await prisma.item.create({ data: { sku: "BB-RACE-1", name: "Bahan Race 1", type: "BAHAN_BAKU", unit: "pcs" } });
    await receive(it.id, 10, 1000, locs.raw!);
    const out = () => prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: it.id, qty: 7, fromLocationId: locs.raw }, actor));
    const res = await Promise.allSettled([out(), out(), out()]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    for (const r of res) if (r.status === "rejected") expect(String(r.reason)).toMatch(/tidak cukup/);
    expect(await qtyAt(prisma, it.id, locs.raw!)).toBe(3);
  });

  it("penerimaan bersamaan tidak saling menimpa harga rata-rata", async () => {
    const it = await prisma.item.create({ data: { sku: "BB-RACE-2", name: "Bahan Race 2", type: "BAHAN_BAKU", unit: "pcs" } });
    await Promise.all([receive(it.id, 10, 1000, locs.raw!), receive(it.id, 10, 3000, locs.raw!)]);
    expect(await itemQty(prisma, it.id)).toBe(20);
    expect(await avg(it.id)).toBe(2000);
  });
});

describe("R3: setoran borongan banyak pekerja atomik", () => {
  it("satu baris gagal → tidak ada setoran yang tersimpan", async () => {
    const point = await prisma.boronganPoint.findUniqueOrThrow({ where: { code: "BMR" } });
    const w = await savePerson({ name: "Pekerja Atomik", role: "PEKERJA", pointId: point.id }, actor, all);
    const task = await prisma.pieceTask.create({ data: { code: "UJI-ATOMIK", name: "Tugas Uji Atomik", ratePerPcs: 10n, workerRate: 10n } });
    const date = dateOnly("2027-06-11");
    const before = await prisma.boronganResult.count({ where: { taskId: task.id } });
    await expect(
      recordResults([
        { pointId: point.id, taskId: task.id, date, workerId: w.id, qty: 5 },
        { pointId: point.id, taskId: task.id, date, workerId: "tidak-ada", qty: 3 },
      ], actor, all),
    ).rejects.toThrow();
    expect(await prisma.boronganResult.count({ where: { taskId: task.id } })).toBe(before);
    const ok = await recordResults([{ pointId: point.id, taskId: task.id, date, workerId: w.id, qty: 5 }, { pointId: point.id, taskId: task.id, date, workerId: w.id, qty: 2 }], actor, all);
    expect(ok.length).toBe(2);
  });
});
