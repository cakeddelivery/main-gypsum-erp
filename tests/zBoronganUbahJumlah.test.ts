import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { changeShipmentQty, createPickup, createShipment, saveAllots, shipmentView } from "@/lib/boronganFlow";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const supervisor: Scope = { all: true, owner: false, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

describe("Ubah jumlah kiriman (Owner/Supervisor)", () => {
  let actor: { id: string; name: string };
  const ctx = {} as { point: { id: string; locationId: string }; cowok: string; cewek: string; kCowok: string; kCewek: string; driver: string; drv: string; wip: string; wA: string; wB: string };
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `UJ${tag}`, name: `Rakit ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LUJ${tag}`, name: `Titik UJ ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `UJ${tag}`, name: `Titik UJ ${tag}`, locationId: loc.id } });
    const item = (name: string, openingQty: number) => saveItemRecord({ name: `${name} ${tag}`, type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kCowok = await item("Kering Cowok UJ", 1000);
    const kCewek = await item("Kering Cewek UJ", 1000);
    const out = await item("Jadi UJ", 0);
    const mk = (n: string, input: string) => prisma.pieceTask.create({ data: { code: `UJ${n}${tag}`.toUpperCase(), name: `Rakit${tag} ${n}`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: out.id, inputs: { create: [{ itemId: input, qty: 1 }] } } });
    const cowok = await mk("Cowok", kCowok.id);
    const cewek = await mk("Cewek", kCewek.id);
    const driver = await savePerson({ name: `Driver ${tag}`, role: "DRIVER" }, actor, all);
    const wA = await savePerson({ name: `A ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wB = await savePerson({ name: `B ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wip = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_wip" } })).value;
    const drv = (await prisma.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value ?? (await prisma.location.findUniqueOrThrow({ where: { code: "DRV" } })).id;
    Object.assign(ctx, { point, cowok: cowok.id, cewek: cewek.id, kCowok: kCowok.id, kCewek: kCewek.id, driver: driver.id, drv, wip, wA: wA.id, wB: wB.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: ctx.point.id }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: ctx.point.id }, data: { active: false } });
    await prisma.pieceTask.updateMany({ where: { id: { in: [ctx.cowok, ctx.cewek] } }, data: { active: false } });
  });

  const driverScope = (): Scope => ({ all: false, pointIds: [ctx.point.id], personId: ctx.driver, taskIds: null, driver: true });
  let sid = "";
  it("Cewek 700 dibagi 600 → turunkan ke 600: bahan kembali ke gudang (mutasi koreksi), audit lama→baru, ringkasan diperbarui", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver, tasks: [{ taskId: ctx.cowok, qty: 300 }, { taskId: ctx.cewek, qty: 700 }] }, actor, all);
    sid = s.id;
    await saveAllots(sid, [{ pointId: ctx.point.id, workerId: ctx.wA, taskId: ctx.cowok, qty: 300 }, { pointId: ctx.point.id, workerId: ctx.wB, taskId: ctx.cewek, qty: 600 }], actor, driverScope());
    expect(await at(ctx.kCewek, ctx.wip)).toBe(300); // 1000 − 700
    const movesBefore = await prisma.stockMovement.count({ where: { ref: `KRM:${s.number}` } });
    // Hanya pengelola; alasan wajib; tidak boleh < dibagi
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cewek, qty: 600 }], "salah hitung", actor, driverScope())).rejects.toThrow(/Owner \/ Supervisor/);
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cewek, qty: 600 }], " ", actor, all)).rejects.toThrow(/alasan/i);
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cewek, qty: 599 }], "salah hitung", actor, all)).rejects.toThrow(/tidak boleh kurang dari yang sudah dibagi.*600/);
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cewek, qty: 700 }], "uji", actor, all)).rejects.toThrow(/Tidak ada perubahan/);
    const r = await changeShipmentQty(sid, [{ taskId: ctx.cewek, qty: 600 }], "patung kering yang dikirim ternyata 600", actor, supervisor);
    expect(r.before).toMatchObject({ Cewek: 700 });
    expect(r.after).toMatchObject({ Cewek: 600 });
    expect(await at(ctx.kCewek, ctx.wip)).toBe(400); // 100 kembali ke gudang asal
    expect(await at(ctx.kCewek, ctx.drv)).toBe(0); // yang tersisa di mobil driver (100) kembali
    // Mutasi lama tidak dihapus: hanya bertambah satu mutasi koreksi
    expect(await prisma.stockMovement.count({ where: { ref: `KRM:${s.number}` } })).toBe(movesBefore + 1);
    const line = await prisma.boronganShipmentLine.findFirstOrThrow({ where: { shipmentId: sid, itemId: ctx.kCewek } });
    expect(Number(line.qty)).toBe(600);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: sid, action: "KIRIMAN_JUMLAH_DIUBAH" } });
    expect(log.data).toMatchObject({ alasan: "patung kering yang dikirim ternyata 600", sebelum: { Cewek: 700, Cowok: 300 }, sesudah: { Cewek: 600, Cowok: 300 } });
    const v = (await shipmentView(sid))!;
    expect(v.tasks.find((t) => t.id === ctx.cewek)?.qty).toBe(600);
    expect(v.totals.sent).toBe(900);
    expect(v.totals.allotted).toBe(900); // sisa 0
  });

  it("tambah jumlah: bahan keluar lagi dari gudang; stok tidak cukup ditolak", async () => {
    const before = await at(ctx.kCowok, ctx.wip);
    await changeShipmentQty(sid, [{ taskId: ctx.cowok, qty: 350 }], "tambah 50", actor, all);
    expect(await at(ctx.kCowok, ctx.wip)).toBe(before - 50);
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cowok, qty: 350 + (before + 1) }], "terlalu banyak", actor, all)).rejects.toThrow(/tidak cukup|Stok/i);
    expect(await at(ctx.kCowok, ctx.wip)).toBe(before - 50); // transaksi dibatalkan, tidak ada perubahan
    expect((await shipmentView(sid))!.tasks.find((t) => t.id === ctx.cowok)?.qty).toBe(350);
  });

  it("kiriman SELESAI atau dibatalkan tidak bisa diubah", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver, tasks: [{ taskId: ctx.cowok, qty: 10 }] }, actor, all);
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: ctx.wA, taskId: ctx.cowok, qty: 10 }], actor, driverScope());
    await createPickup(s.id, [{ pointId: ctx.point.id, workerId: ctx.wA, taskId: ctx.cowok, qty: 10, done: true }], actor, all);
    expect((await shipmentView(s.id))!.state).toBe("SELESAI");
    await expect(changeShipmentQty(s.id, [{ taskId: ctx.cowok, qty: 20 }], "uji", actor, all)).rejects.toThrow(/sudah selesai/);
    await prisma.boronganShipment.update({ where: { id: sid }, data: { closedAt: new Date(), closedBy: "uji" } });
    await expect(changeShipmentQty(sid, [{ taskId: ctx.cowok, qty: 360 }], "uji", actor, all)).rejects.toThrow(/sudah ditutup/);
  });
});
