import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { applyCloseAll, closeLines, planCloseAll, type ClosePlan } from "@/lib/boronganTutup";
import { openShipments, shipmentView } from "@/lib/boronganFlow";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const actor = { id: "uji", name: "Uji tutup borongan" };
const ids = { point: "", shipment: "", result: "" };

describe("borongan:tutup-semua", () => {
  beforeAll(async () => {
    const div = await prisma.division.create({ data: { code: `TT${tag}`, name: `Tutup ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LT${tag}`, name: `Titik T${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `T${tag}`, name: `Titik T${tag}`, locationId: loc.id } });
    const task = await prisma.pieceTask.create({ data: { code: `TT${tag}`, name: `Rakit tutup ${tag}`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n } });
    await prisma.boronganPerson.create({ data: { name: `Koord ${tag}`, role: "KOORDINATOR", pointId: point.id } });
    const w = await prisma.boronganPerson.create({ data: { name: `Pekerja ${tag}`, role: "PEKERJA", pointId: point.id } });
    const s = await prisma.boronganShipment.create({
      data: { number: `KRM-T${tag}`, date: new Date("2026-11-18"), mode: "LANGSUNG", pointIds: [point.id], createdBy: "uji",
        tasks: { create: [{ taskId: task.id, qty: 10 }] }, allots: { create: [{ pointId: point.id, workerId: w.id, taskId: task.id, qty: 10, updatedBy: "uji" }] } },
    });
    const r = await prisma.boronganResult.create({ data: { number: `SET-T${tag}`, pointId: point.id, workerId: w.id, taskId: task.id, date: new Date("2026-11-17"), qty: 4, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, createdBy: "uji" } });
    Object.assign(ids, { point: point.id, shipment: s.id, result: r.id });
  });
  // Titik uji dinonaktifkan agar tidak ikut cakupan titik divisi di tes lain
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: ids.point }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: ids.point }, data: { active: false } });
  });
  const mine = (p: ClosePlan): ClosePlan => ({ ...p, shipments: p.shipments.filter((s) => s.id === ids.shipment), points: p.points.filter((x) => x.pointId === ids.point) });

  it("pratinjau: kiriman terbuka, sisa di pekerja, upah belum diklaim; tidak mengubah apa pun", async () => {
    const plan = mine(await planCloseAll());
    expect(plan.shipments).toEqual([expect.objectContaining({ number: `KRM-T${tag}`, state: "DI_PEKERJA" })]);
    const p = plan.points[0];
    expect(p.cells).toEqual([expect.objectContaining({ kirim: 10, ambil: 0, sisa: 10 })]);
    expect(p.unclaimed.count).toBe(1);
    expect(p.unclaimed.total).toBeGreaterThan(0);
    expect(closeLines(plan).join("\n")).toMatch(/belum diklaim: 1 setoran.*dianggap sudah beres/);
    expect((await shipmentView(ids.shipment))!.state).toBe("DI_PEKERJA");
  });

  it("--jalankan (tanpa upah): SELESAI administratif, tanpa mutasi stok / klaim / jurnal, tercatat di audit", async () => {
    const before = await Promise.all([prisma.stockMovement.count(), prisma.boronganClaim.count(), prisma.journal.count()]);
    const plan = mine(await planCloseAll());
    const r = await prisma.$transaction((tx) => applyCloseAll(tx, plan, actor, { note: "Tutup administratif cut-over uji" }));
    expect(r).toEqual({ closed: 1 });
    const v = (await shipmentView(ids.shipment))!;
    expect(v.state).toBe("SELESAI");
    expect(v.closed).toMatch(/cut-over uji/);
    expect((await openShipments()).some((s) => s.id === ids.shipment)).toBe(false);
    expect(await Promise.all([prisma.stockMovement.count(), prisma.boronganClaim.count(), prisma.journal.count()])).toEqual(before);
    expect((await prisma.boronganResult.findUniqueOrThrow({ where: { id: ids.result } })).claimId).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: ids.shipment, action: "BORONGAN_TUTUP_ADMINISTRATIF" } })).toBe(1);
    // diulang: sudah ditutup, tidak dobel
    expect((await planCloseAll()).shipments.some((s) => s.id === ids.shipment)).toBe(false);
  });
});
