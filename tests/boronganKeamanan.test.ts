import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { cancelPickup, createPickup, createShipment, receivePickup, saveAllots, saveWorkReport } from "@/lib/boronganFlow";
import { saveItemRecord } from "@/lib/items";
import { addDays, todayStr } from "@/lib/time";
import { canSeeClaim } from "@/app/(app)/borongan/klaim/access";
import { isCoordinatorOf } from "@/lib/boronganFlow";
import { boronganScope } from "@/lib/borongan";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

/** Keamanan data borongan: driver / koordinator / Supervisor (backup) / Owner pada pembagian, AMB, dan laporan hasil */
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const ownerScope: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const spvScope: Scope = { all: true, owner: false, backup: true, pointIds: [], personId: null, taskIds: null };

describe("Keamanan data borongan per peran", () => {
  let actor: { id: string; name: string };
  const other = { id: "orang-lain", name: "Driver Lain" };
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `KM${tag}`, name: `Aman ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LK${tag}`, name: `Titik K${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `K${tag}`, name: `Titik K${tag}`, locationId: loc.id, viaDriver: true } });
    const loc2 = await prisma.location.create({ data: { code: `LM${tag}`, name: `Titik M${tag}` } });
    const point2 = await prisma.boronganPoint.create({ data: { code: `M${tag}`, name: `Titik M${tag}`, locationId: loc2.id, viaDriver: true } });
    const item = (name: string, type: "BARANG_DALAM_PROSES", openingQty = 0) => saveItemRecord({ name: `${name} ${tag}`, type, category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kering = await item("Kering", "BARANG_DALAM_PROSES", 500);
    const jadi = await item("Jadi", "BARANG_DALAM_PROSES");
    const task = await prisma.pieceTask.create({ data: { code: `TK${tag}`, name: `Rakit${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: jadi.id, inputs: { create: [{ itemId: kering.id, qty: 1 }] } } });
    const coord = await savePerson({ name: `Koor ${tag}`, role: "KOORDINATOR", pointId: point.id }, actor, ownerScope);
    const driver = await savePerson({ name: `Drv ${tag}`, role: "DRIVER" }, actor, ownerScope);
    const wA = await savePerson({ name: `Pekerja A ${tag}`, role: "PEKERJA", pointId: point.id }, actor, ownerScope);
    const wB = await savePerson({ name: `Pekerja B ${tag}`, role: "PEKERJA", pointId: point.id }, actor, ownerScope);
    return {
      div, point, point2, task, wA, wB,
      coordScope: { all: false, pointIds: [point.id], personId: coord.id, taskIds: null } as Scope,
      driverScope: { all: false, pointIds: [point.id], personId: driver.id, taskIds: null, driver: true } as Scope,
      driverId: driver.id,
    };
  }
  beforeAll(async () => { ctx = await setup(); });
  afterAll(async () => { await prisma.boronganPoint.updateMany({ where: { id: { in: [ctx.point.id, ctx.point2.id] } }, data: { active: false } }); });

  async function shipment(day: string) {
    const s = await createShipment({ date: day, mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driverId, tasks: [{ taskId: ctx.task.id, qty: 100 }] }, actor, ownerScope);
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: ctx.wA.id, taskId: ctx.task.id, qty: 60 }, { pointId: ctx.point.id, workerId: ctx.wB.id, taskId: ctx.task.id, qty: 40 }], actor, ctx.driverScope);
    return s;
  }
  const pick = (id: string, qty: number, by = actor) => createPickup(id, [{ pointId: ctx.point.id, workerId: ctx.wA.id, taskId: ctx.task.id, qty, done: false }], by, ctx.driverScope);

  it("1. Pembagian dikunci setelah AMB pertama: driver ditolak; Supervisor/Owner wajib alasan, tidak boleh di bawah yang sudah diambil; audit sebelum→sesudah", async () => {
    const s = await shipment("2027-06-01");
    const rows = (a: number, b: number) => [{ pointId: ctx.point.id, workerId: ctx.wA.id, taskId: ctx.task.id, qty: a }, { pointId: ctx.point.id, workerId: ctx.wB.id, taskId: ctx.task.id, qty: b }];
    // Sebelum AMB: driver masih boleh mengubah; koordinator tidak
    await expect(saveAllots(s.id, rows(50, 50), actor, ctx.coordScope)).rejects.toThrow(/dicatat driver/);
    await saveAllots(s.id, rows(50, 50), actor, ctx.driverScope);
    await pick(s.id, 20);
    await expect(saveAllots(s.id, rows(40, 60), actor, ctx.driverScope)).rejects.toThrow(/tidak bisa diubah setelah ada pengambilan/);
    await expect(saveAllots(s.id, rows(40, 60), actor, spvScope)).rejects.toThrow(/alasan/);
    // Tidak boleh di bawah yang sudah diambil (20)
    await expect(saveAllots(s.id, rows(10, 90), actor, spvScope, { reason: "koreksi" })).rejects.toThrow(/tidak boleh kurang dari yang sudah diambil/);
    await saveAllots(s.id, rows(30, 70), actor, spvScope, { reason: "Pekerja A sakit" });
    const log = await prisma.auditLog.findFirst({ where: { action: "PEMBAGIAN_BORONGAN", entityId: s.id }, orderBy: { id: "desc" } });
    const d = log!.data as { sebelum: Record<string, number>; sesudah: Record<string, number>; alasan: string; setelahPengambilan: boolean };
    expect([Object.values(d.sebelum), Object.values(d.sesudah), d.alasan, d.setelahPengambilan]).toEqual([[50, 50], [30, 70], "Pekerja A sakit", true]);
  });

  it("2. Batalkan AMB: driver hanya miliknya, hari ini, dengan alasan; Supervisor/Owner lainnya; dihitung divisi hanya Owner (dengan pembalik); koordinator tidak pernah", async () => {
    const s = await shipment("2027-06-02");
    const mine = await pick(s.id, 10);
    // alasan wajib
    await expect(cancelPickup(mine.id, actor, ctx.driverScope, "")).rejects.toThrow(/alasan/);
    // koordinator tidak boleh
    await expect(cancelPickup(mine.id, actor, ctx.coordScope, "coba")).rejects.toThrow(/Koordinator/);
    // driver lain tidak boleh membatalkan milik orang
    await expect(cancelPickup(mine.id, other, ctx.driverScope, "bukan milik saya")).rejects.toThrow(/Hanya pencatatnya/);
    // milik sendiri, hari ini → boleh
    await cancelPickup(mine.id, actor, ctx.driverScope, "salah catat");
    expect((await prisma.boronganPickup.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("DIBATALKAN");
    const log = await prisma.auditLog.findFirst({ where: { action: "AMBIL_SETORAN_DIBATALKAN", entityId: mine.id } });
    expect((log!.data as { alasan: string; sebelum: { status: string } }).sebelum.status).toBe("DIBAWA");

    // AMB kemarin: driver ditolak, Supervisor boleh
    const old = await pick(s.id, 10);
    await prisma.boronganPickup.update({ where: { id: old.id }, data: { createdAt: new Date(`${addDays(todayStr(), -2)}T03:00:00Z`) } });
    await expect(cancelPickup(old.id, actor, ctx.driverScope, "telat")).rejects.toThrow(/hari yang sama/);
    await cancelPickup(old.id, actor, spvScope, "koreksi Supervisor");
    expect((await prisma.boronganPickup.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("DIBATALKAN");

    // Sudah dihitung divisi: Supervisor ditolak, Owner boleh dengan pembalik
    const counted = await pick(s.id, 15);
    const divScope: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [ctx.task.id], division: { id: ctx.div.id, captain: true } };
    await receivePickup(counted.id, [{ taskId: ctx.task.id, qty: 15 }], actor, divScope);
    expect(await prisma.boronganResult.count({ where: { pickupId: counted.id } })).toBeGreaterThan(0);
    await expect(cancelPickup(counted.id, actor, spvScope, "salah")).rejects.toThrow(/hanya bisa dibatalkan Owner/);
    await expect(cancelPickup(counted.id, actor, ctx.driverScope, "salah")).rejects.toThrow(/hanya bisa dibatalkan Owner/);
    await cancelPickup(counted.id, actor, ownerScope, "dihitung ganda");
    expect((await prisma.boronganPickup.findUniqueOrThrow({ where: { id: counted.id } })).status).toBe("DIBATALKAN");
    expect(await prisma.boronganResult.count({ where: { pickupId: counted.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "AMBIL_SETORAN_DIBALIK_OWNER", entityId: counted.id } })).toBe(1);
  });

  it("3. Laporan hasil koordinator terkunci setelah AMB-nya dihitung divisi; koreksi hanya Supervisor/Owner dengan alasan; audit sebelum→sesudah", async () => {
    const s = await shipment("2027-06-03");
    const rep = (good: number, reject = 0) => [{ workerId: ctx.wA.id, taskId: ctx.task.id, good, reject }, { workerId: ctx.wB.id, taskId: ctx.task.id, good: 30, reject: 0 }];
    await saveWorkReport(s.id, ctx.point.id, rep(50), true, actor, ctx.coordScope);
    // Sebelum dihitung: koordinator masih boleh menyunting
    await saveWorkReport(s.id, ctx.point.id, rep(55), true, actor, ctx.coordScope);
    const amb = await pick(s.id, 55);
    const divScope: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [ctx.task.id], division: { id: ctx.div.id, captain: true } };
    await receivePickup(amb.id, [{ taskId: ctx.task.id, qty: 55 }], actor, divScope);
    // Setelah dihitung: mengubah angka pekerja A ditolak untuk koordinator; angka sama diperbolehkan
    await expect(saveWorkReport(s.id, ctx.point.id, rep(56), true, actor, ctx.coordScope)).rejects.toThrow(/tidak bisa diubah/);
    await saveWorkReport(s.id, ctx.point.id, rep(55), true, actor, ctx.coordScope);
    // Supervisor: wajib alasan; audit sebelum→sesudah
    await expect(saveWorkReport(s.id, ctx.point.id, rep(56), true, actor, spvScope)).rejects.toThrow(/alasan/);
    await saveWorkReport(s.id, ctx.point.id, rep(56), true, actor, spvScope, { reason: "koreksi hitungan" });
    const log = await prisma.auditLog.findFirst({ where: { action: "LAPORAN_HASIL_BORONGAN", entityId: s.id }, orderBy: { id: "desc" } });
    const d = log!.data as { sebelum: Record<string, string>; sesudah: Record<string, string>; alasan: string };
    expect([Object.values(d.sebelum)[0], Object.values(d.sesudah)[0], d.alasan]).toEqual(["55/0", "56/0", "koreksi hitungan"]);
  });

  it("4. Koordinator: klaim & stok hanya titiknya sendiri (juga lewat ID langsung); tidak ada hak pengelola", async () => {
    const user = await prisma.user.create({ data: { username: `koor${tag.toLowerCase()}`, name: `Koordinator Uji ${tag}`, passwordHash: "x", role: "KOORDINATOR" } });
    await prisma.boronganPerson.create({ data: { name: `Koor Akun ${tag}`, role: "KOORDINATOR", pointId: ctx.point.id, userId: user.id } });
    const u = { id: user.id, role: "KOORDINATOR", divisionId: null, can: () => false } as unknown as Parameters<typeof canSeeClaim>[0];
    expect(await canSeeClaim(u, ctx.point.id)).toBe(true);
    expect(await canSeeClaim(u, ctx.point2.id)).toBe(false);
    const scope = await boronganScope(prisma, u as never);
    expect([scope.all, scope.backup, scope.owner, isCoordinatorOf(scope, ctx.point.id), isCoordinatorOf(scope, ctx.point2.id)]).toEqual([false, undefined, undefined, true, false]);
  });
});
