// Dijalankan paling akhir (urut nama): menonaktifkan tugas borongan lama & mengubah stok awal, jangan ganggu tes lain
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { inventoryValuation, locationSettings, qtyAt, recordMovement, valuationByLocation } from "@/lib/stock";
import { POINT_CONFIG_KEY, pointConfig, setupBorongan } from "@/lib/boronganSetup";
import { recordResults, boronganScope } from "@/lib/borongan";
import { saveOpeningStock } from "@/lib/stockOpening";
import { COA } from "@/lib/accounting";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Siapkan borongan (titik Beringin, tugas per karakter/warna, paket per titik)", () => {
  it("pratinjau tidak menyimpan; --jalankan menyimpan dan aman diulang", async () => {
    const before = await prisma.pieceTask.count();
    const log = await setupBorongan(prisma, false);
    expect(log.join("\n")).toContain("Titik borongan BERINGIN");
    expect(await prisma.pieceTask.count()).toBe(before);
    expect(await prisma.boronganPoint.findFirst({ where: { code: "BRN" } })).toBeNull();

    await setupBorongan(prisma, true);
    const brn = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "BRN" } });
    const names = (await prisma.pieceTask.findMany({ where: { active: true } })).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Assembling Hewan", "Assembling Cewek", "Cat plastik merah", "Cat plastik kuning"]));
    expect(names).not.toContain("Assembling");
    const asmH = await prisma.pieceTask.findFirstOrThrow({ where: { name: "Assembling Hewan" }, include: { inputs: { include: { item: true } }, outputItem: true } });
    expect(Number(asmH.workerRate) + Number(asmH.coordinatorRate) + Number(asmH.driverRate)).toBe(60);
    expect(asmH.inputs.map((i) => i.item.name)).toEqual(["Patung kering Hewan"]);
    expect(asmH.outputItem?.type).toBe("BARANG_JADI");
    const cfg = await pointConfig(prisma);
    const bmr = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "BMR" } });
    const mst = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "MST" } });
    expect(cfg[bmr.id].tasks).toHaveLength(5); // 4 assembling + cat giftbox
    expect(cfg[mst.id].tasks).toHaveLength(4);
    expect(cfg[brn.id].tasks).toHaveLength(3);
    const brnKit = await prisma.item.findMany({ where: { id: { in: cfg[brn.id].kit } } });
    expect(brnKit.map((i) => i.name).sort()).toEqual(["Cat biru", "Cat kuning", "Cat merah", "Plastik klip 2x3"]);

    const count = await prisma.pieceTask.count();
    const again = await setupBorongan(prisma, true);
    expect(await prisma.pieceTask.count()).toBe(count);
    expect(again.join("\n")).toContain("sudah ada");
    expect(await prisma.setting.findUnique({ where: { key: POINT_CONFIG_KEY } })).toBeTruthy();
  });

  it("setoran tugas yang bukan milik titik ditolak", async () => {
    const brn = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "BRN" } });
    const asm = await prisma.pieceTask.findFirstOrThrow({ where: { name: "Assembling Hewan" } });
    const w = await prisma.boronganPerson.create({ data: { name: "Pekerja Beringin Uji", role: "PEKERJA", pointId: brn.id } });
    await expect(recordResults([{ pointId: brn.id, workerId: w.id, taskId: asm.id, date: dateOnly("2027-07-01"), qty: 1 }], actor, await boronganScope(prisma, { id: actor.id, can: () => true }))).rejects.toThrow(/tidak dikerjakan di titik Beringin/);
  });
});

describe("Stok awal riil & nilai persediaan per lokasi", () => {
  it("menyamakan stok gudang, harga diisi, selisih nilai ke Ekuitas Saldo Awal; total per lokasi = valuasi", async () => {
    const { raw } = await locationSettings(prisma);
    const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const a = await prisma.item.create({ data: { sku: "BB-AWAL-UJI-1", name: "Dus awal uji", type: "BAHAN_BAKU", unit: "pcs", divisionId: d.id } });
    const b = await prisma.item.create({ data: { sku: "BB-AWAL-UJI-2", name: "Solasi awal uji", type: "BAHAN_BAKU", unit: "pcs", divisionId: d.id } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: b.id, qty: 10, toLocationId: raw!, unitCost: 1000, date: jakartaDateTime("2027-07-01", "06:00") }, actor));
    const r = await saveOpeningStock([{ itemId: a.id, physical: 100, unitCost: 500 }, { itemId: b.id, physical: 6 }], jakartaDateTime("2027-07-02", "06:00"), actor);
    expect(r.changed).toBe(2);
    expect(r.delta.BAHAN_BAKU).toBe(100 * 500 - 4 * 1000);
    expect(await qtyAt(prisma, a.id, raw!)).toBe(100);
    expect(await qtyAt(prisma, b.id, raw!)).toBe(6);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).avgCost)).toBe(500);
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "STOK_AWAL" }, include: { lines: { include: { account: true } } } });
    expect(j.lines.find((l) => l.account.code === COA.EKUITAS_SALDO_AWAL)?.credit).toBe(BigInt(46_000));

    const loc = await valuationByLocation(prisma);
    const val = await inventoryValuation(prisma);
    expect(Math.abs(loc.total.total - val.total)).toBeLessThan(100); // beda pembulatan per lokasi saja
    expect(loc.rows.some((x) => x.id === raw)).toBe(true);
  });
});
