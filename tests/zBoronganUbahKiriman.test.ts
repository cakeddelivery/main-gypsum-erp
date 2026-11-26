import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { canViewShipment, cancelShipment, createPickup, createShipment, editShipment, saveAllots, shipmentView } from "@/lib/boronganFlow";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

describe("Ubah semua data kiriman (Owner/Supervisor)", () => {
  let actor: { id: string; name: string };
  const c = {} as { p1: { id: string; locationId: string }; p2: { id: string; locationId: string }; kCowok: string; bahan: string; cowok: string; driver: string; drv: string; wip: string; raw: string; wA: string };
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `UK${tag}`, name: `Rakit UK ${tag}` } });
    const mkPoint = async (n: string) => {
      const loc = await prisma.location.create({ data: { code: `LUK${n}${tag}`, name: `Titik UK${n} ${tag}` } });
      return prisma.boronganPoint.create({ data: { code: `UK${n}${tag}`, name: `Titik UK${n} ${tag}`, locationId: loc.id } });
    };
    const p1 = await mkPoint("1");
    const p2 = await mkPoint("2");
    const item = (name: string, type: "BARANG_DALAM_PROSES" | "BAHAN_BAKU", openingQty: number) => saveItemRecord({ name: `${name} ${tag}`, type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kCowok = await item("Kering Cowok UK", "BARANG_DALAM_PROSES", 1000);
    const bahan = await item("Cat UK", "BAHAN_BAKU", 500);
    const out = await item("Jadi UK", "BARANG_DALAM_PROSES", 0);
    const t = await prisma.pieceTask.create({ data: { code: `UKC${tag}`, name: `RakitUK${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: out.id, inputs: { create: [{ itemId: kCowok.id, qty: 1 }] } } });
    const driver = await savePerson({ name: `Driver UK ${tag}`, role: "DRIVER" }, actor, all);
    const wA = await savePerson({ name: `A UK ${tag}`, role: "PEKERJA", pointId: p1.id }, actor, all);
    const wip = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_wip" } })).value;
    const raw = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_raw" } })).value;
    const drv = (await prisma.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value ?? (await prisma.location.findUniqueOrThrow({ where: { code: "DRV" } })).id;
    Object.assign(c, { p1, p2, kCowok: kCowok.id, bahan: bahan.id, cowok: t.id, driver: driver.id, drv, wip, raw, wA: wA.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: { in: [c.p1.id, c.p2.id] } }, data: { active: false } });
    await prisma.boronganPoint.updateMany({ where: { id: { in: [c.p1.id, c.p2.id] } }, data: { active: false } });
    await prisma.pieceTask.update({ where: { id: c.cowok }, data: { active: false } });
  });

  it("lewat driver → diantar langsung & pindah titik: stok kembali dari lokasi lama lalu keluar ke lokasi baru, audit lama→baru", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [c.p1.id], driverId: c.driver, tasks: [{ taskId: c.cowok, qty: 100 }], support: [] }, actor, all);
    expect(await at(c.kCowok, c.drv)).toBe(100);
    const sup: Scope = { ...all, owner: false };
    await expect(editShipment(s.id, { mode: "LANGSUNG" }, "diantar langsung", actor, { all: false, pointIds: [], personId: null, taskIds: null })).rejects.toThrow(/Owner \/ Supervisor/);
    await expect(editShipment(s.id, { mode: "LANGSUNG" }, "  ", actor, all)).rejects.toThrow(/alasan/i);
    await expect(editShipment(s.id, {}, "tidak ada apa-apa", actor, all)).rejects.toThrow(/Tidak ada perubahan/);
    const r = await editShipment(s.id, { mode: "LANGSUNG", pointIds: [c.p2.id], date: "2026-11-21", note: "diantar sendiri", driverId: null }, "ternyata diantar langsung ke titik 2", actor, sup);
    expect(Object.keys(r.sesudah)).toEqual(expect.arrayContaining(["tanggal", "cara kirim", "titik", "driver", "catatan"]));
    expect(await at(c.kCowok, c.drv)).toBe(0); // kembali dari mobil
    expect(await at(c.kCowok, c.p2.locationId)).toBe(100); // keluar ke titik baru
    expect(await at(c.kCowok, c.wip)).toBe(900);
    const v = (await shipmentView(s.id))!;
    expect(v).toMatchObject({ mode: "LANGSUNG", driver: null, date: "2026-11-21", note: "diantar sendiri" });
    expect(v.points.map((p) => p.id)).toEqual([c.p2.id]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: s.id, action: "KIRIMAN_DIUBAH" } });
    expect(log.data).toMatchObject({ alasan: "ternyata diantar langsung ke titik 2", sebelum: { "cara kirim": "lewat driver" }, sesudah: { "cara kirim": "diantar langsung" } });
  });

  it("jumlah per jenis + bahan/kit (tambah, kurangi, hapus, tambah item)", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [c.p1.id], driverId: c.driver, tasks: [{ taskId: c.cowok, qty: 100 }] }, actor, all);
    const cfg = await prisma.pieceTask.findUniqueOrThrow({ where: { id: c.cowok } });
    expect(cfg.active).toBe(true);
    // Bahan baku di luar kit jenis hanya lewat pengeditan (tambah item baru)
    await editShipment(s.id, { tasks: [{ taskId: c.cowok, qty: 150 }], lines: [{ itemId: c.bahan, qty: 40 }] }, "tambah 50 patung + 40 cat", actor, all);
    expect(await at(c.kCowok, c.drv)).toBeGreaterThanOrEqual(150);
    expect(await at(c.bahan, c.drv)).toBe(40);
    await editShipment(s.id, { lines: [{ itemId: c.bahan, qty: 25 }] }, "kurangi cat", actor, all);
    expect(await at(c.bahan, c.drv)).toBe(25);
    expect(await at(c.bahan, c.raw)).toBe(475);
    await editShipment(s.id, { lines: [{ itemId: c.bahan, qty: 0 }] }, "hapus cat", actor, all);
    expect(await at(c.bahan, c.drv)).toBe(0);
    expect(await at(c.bahan, c.raw)).toBe(500);
    const v = (await shipmentView(s.id))!;
    expect(v.lines.find((l) => l.itemId === c.bahan)).toBeUndefined();
    expect(v.tasks[0].qty).toBe(150);
  });

  it("batas: titik sudah dibagi tidak bisa dilepas; selesai hanya catatan & driver; dibatalkan ditolak", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [c.p1.id], driverId: c.driver, tasks: [{ taskId: c.cowok, qty: 10 }] }, actor, all);
    const driverScope: Scope = { all: false, pointIds: [c.p1.id], personId: c.driver, taskIds: null, driver: true };
    await saveAllots(s.id, [{ pointId: c.p1.id, workerId: c.wA, taskId: c.cowok, qty: 10 }], actor, driverScope);
    await expect(editShipment(s.id, { pointIds: [c.p2.id] }, "pindah", actor, all)).rejects.toThrow(/sudah dibagi/);
    await expect(editShipment(s.id, { mode: "LANGSUNG" }, "ubah cara", actor, all)).rejects.toThrow(/Cara kirim tidak bisa diubah/);
    await expect(editShipment(s.id, { tasks: [{ taskId: c.cowok, qty: 5 }] }, "kurang", actor, all)).rejects.toThrow(/tidak boleh kurang dari yang sudah dibagi/);
    await createPickup(s.id, [{ pointId: c.p1.id, workerId: c.wA, taskId: c.cowok, qty: 10, done: true }], actor, all);
    expect((await shipmentView(s.id))!.state).toBe("SELESAI");
    await expect(editShipment(s.id, { date: "2026-11-20" }, "tanggal", actor, all)).rejects.toThrow(/hanya catatan & driver/);
    await editShipment(s.id, { note: "catatan baru" }, "catatan", actor, all);
    expect((await shipmentView(s.id))!.note).toBe("catatan baru");

    const x = await createShipment({ date: "2026-11-22", mode: "DRIVER", pointIds: [c.p1.id], driverId: c.driver, tasks: [{ taskId: c.cowok, qty: 5 }] }, actor, all);
    await cancelShipment(x.id, actor, all, "salah catat");
    expect(await prisma.auditLog.count({ where: { entityId: x.id, action: "KIRIMAN_BORONGAN_DIBATALKAN" } })).toBe(1);
    await expect(editShipment(x.id, { note: "x" }, "uji", actor, all)).rejects.toThrow(/dibatalkan/);
  });

  it("hak lihat detail: koordinator hanya titiknya, driver hanya kiriman lewat driver", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "LANGSUNG", pointIds: [c.p2.id], tasks: [{ taskId: c.cowok, qty: 5 }] }, actor, all);
    const v = (await shipmentView(s.id))!;
    expect(canViewShipment(all, v)).toBe(true);
    expect(canViewShipment({ all: false, pointIds: [c.p1.id], personId: "k", taskIds: null }, v)).toBe(false);
    expect(canViewShipment({ all: false, pointIds: [c.p2.id], personId: "k", taskIds: null }, v)).toBe(true);
    expect(canViewShipment({ all: false, pointIds: [c.p2.id], personId: c.driver, taskIds: null, driver: true }, v)).toBe(false);
  });
});
