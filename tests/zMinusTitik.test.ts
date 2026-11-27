import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { createPickup, createShipment, receiveByColor, receivePickup, saveAllots, saveWorkReport, syncPickupOutput } from "@/lib/boronganFlow";
import { saveItemRecord } from "@/lib/items";
import { locationSettings, qtyAt, recordMovement, stockBalances } from "@/lib/stock";
import { applyMinusTitik, planMinusTitik } from "@/lib/koreksiMinusTitik";
import { fisikDariLaporan } from "@/lib/fisikDariLaporan";
import { RESULT_KEY } from "@/lib/shiftResultCount";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { dateOnly } from "@/lib/time";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();

describe("Stok hasil di titik tidak pernah minus; koreksi minus titik", () => {
  let actor: { id: string; name: string };
  const c = {} as { point: { id: string; locationId: string }; div: string; kering: string; bahan: string; out: string; outColor: string; task: string; taskColor: string; driver: string; w: string; wh: string };
  const at = (itemId: string, locationId: string) => qtyAt(prisma, itemId, locationId);

  let prevFlow: string | undefined;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    // Sakelar hasil kerja → stok menyala: reject penerimaan ikut dibuang dari titik (dibatasi stok titik)
    prevFlow = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value;
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const div = await prisma.division.create({ data: { code: `MT${tag}`, name: `Minus ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LMT${tag}`, name: `Titik MT ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `MT${tag}`, name: `Titik MT ${tag}`, locationId: loc.id } });
    const item = (name: string, type: "BARANG_DALAM_PROSES" | "BAHAN_BAKU", openingQty: number) => saveItemRecord({ name: `${name} ${tag}`, type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kering = await item("Kering MT", "BARANG_DALAM_PROSES", 1000);
    const bahan = await item("Bahan Cat MT", "BAHAN_BAKU", 500);
    const out = await item("Jadi MT", "BARANG_DALAM_PROSES", 0);
    const outColor = await item("Cat plastik MT", "BARANG_DALAM_PROSES", 0);
    const task = await prisma.pieceTask.create({ data: { code: `MTA${tag}`, name: `RakitMT${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: out.id, inputs: { create: [{ itemId: kering.id, qty: 1 }] } } });
    const taskColor = await prisma.pieceTask.create({ data: { code: `MTC${tag}`, name: `Cat plastik MT${tag} merah`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n, outputItemId: outColor.id, resultAtReceipt: true, inputs: { create: [{ itemId: bahan.id, qty: 1 }] } } });
    const driver = await savePerson({ name: `Driver MT ${tag}`, role: "DRIVER" }, actor, all);
    const w = await savePerson({ name: `A MT ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wh = (await locationSettings(prisma)).wip!;
    Object.assign(c, { point, div: div.id, kering: kering.id, bahan: bahan.id, out: out.id, outColor: outColor.id, task: task.id, taskColor: taskColor.id, driver: driver.id, w: w.id, wh });
  });
  afterAll(async () => {
    if (prevFlow === undefined) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
    else await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: prevFlow } });
    await prisma.boronganPerson.updateMany({ where: { pointId: c.point.id }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: c.point.id }, data: { active: false } });
    await prisma.pieceTask.updateMany({ where: { id: { in: [c.task, c.taskColor] } }, data: { active: false } });
  });

  it("Kirim Cat → lapor → terima per warna: saldo titik barang hasil tidak pernah minus di tiap langkah", async () => {
    const s = await createShipment({ date: "2026-11-27", mode: "LANGSUNG", pointIds: [c.point.id], tasks: [{ taskId: c.taskColor, qty: 0 }], support: [{ itemId: c.bahan, qty: 100 }] }, actor, all);
    expect(await at(c.outColor, c.point.locationId)).toBe(0);
    await saveWorkReport(s.id, c.point.id, [{ workerId: c.w, taskId: c.taskColor, good: 60, reject: 0 }], true, actor, all);
    expect(await at(c.outColor, c.point.locationId)).toBeGreaterThanOrEqual(0);
    // Reject penerimaan (#191) juga dibatasi stok titik: 60 dilapor, 60 bagus diterima + 5 reject → reject 5 tidak ada barangnya di titik → hanya dicatat
    await receiveByColor(s.id, c.point.id, [{ taskId: c.taskColor, qty: 60, reject: 5 }], actor, all);
    expect(await at(c.outColor, c.point.locationId)).toBe(0); // 60 masuk titik (laporan), 60 pindah ke gudang (diterima); reject tidak membuat minus
    expect(await at(c.outColor, c.wh)).toBe(60);
    expect((await prisma.boronganPickupCount.findFirstOrThrow({ where: { taskId: c.taskColor, pickup: { shipmentId: s.id } } })).reject).toBe(5);
  });

  it("Kirim Assembling → bagi → ambil → terima (cocok / kurang): saldo titik hasil tidak pernah minus", async () => {
    const driverScope: Scope = { all: false, pointIds: [c.point.id], personId: c.driver, taskIds: null, driver: true };
    const mk = async (qty: number) => {
      const s = await createShipment({ date: "2026-11-27", mode: "DRIVER", pointIds: [c.point.id], driverId: c.driver, tasks: [{ taskId: c.task, qty }] }, actor, all);
      await saveAllots(s.id, [{ pointId: c.point.id, workerId: c.w, taskId: c.task, qty }], actor, driverScope);
      return createPickup(s.id, [{ pointId: c.point.id, workerId: c.w, taskId: c.task, qty, done: true }], actor, all);
    };
    // Normal: hasil tercatat di titik lalu dipindah penuh
    const p1 = await mk(40);
    await receivePickup(p1.id, [{ taskId: c.task, qty: 35, reject: 5 }], actor, all);
    expect(await at(c.out, c.point.locationId)).toBe(0); // 35 bagus ke gudang + 5 reject dibuang dari titik (barangnya ada di titik)
    // Pengambilan kedua dengan hitungan kurang (ditahan): tetap tidak ada saldo minus di titik
    const p2 = await mk(30);
    await receivePickup(p2.id, [{ taskId: c.task, qty: 20 }], actor, all);
    expect(await at(c.out, c.point.locationId)).toBeGreaterThanOrEqual(0);
    // Setoran lama yang barang hasilnya tidak pernah tercatat di titik (mutasi hasil & pindah tidak ada): sinkron tidak mengeluarkan dari titik
    const p3 = await mk(10);
    await receivePickup(p3.id, [{ taskId: c.task, qty: 10 }], actor, all);
    const res = await prisma.boronganResult.findMany({ where: { pickupId: p3.id }, select: { id: true } });
    await prisma.stockMovement.deleteMany({ where: { OR: [{ ref: `AMB:${p3.number}` }, { ref: { in: res.map((x) => `HSB:${x.id}`) }, itemId: c.out }] } });
    // Kosongkan sisa stok titik (sisa pengambilan sebelumnya) supaya tidak ada barang hasil di titik
    const left = await at(c.out, c.point.locationId);
    if (left > 0) await prisma.$transaction((tx) => recordMovement(tx, { type: "PENYESUAIAN", itemId: c.out, qty: left, fromLocationId: c.point.locationId, increase: false, allowNegative: true, ref: "UJI-MT2", note: "uji" }, actor));
    const pt0 = await at(c.out, c.point.locationId);
    const capped = await prisma.$transaction((tx) => syncPickupOutput(tx, p3.id, new Map([[c.task, 10]]), actor));
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ diminta: 10, dipindah: 0 });
    expect(await at(c.out, c.point.locationId)).toBe(pt0);
    expect(pt0).toBeGreaterThanOrEqual(0);
  });

  it("koreksi minus titik: saldo minus di titik & driver dinolkan (OPT), saldo lain & gudang utama tidak berubah; aman diulang", async () => {
    const drv = (await prisma.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value ?? (await prisma.location.findUniqueOrThrow({ where: { code: "DRV" } })).id;
    await prisma.$transaction(async (tx) => {
      const have = await qtyAt(tx, c.bahan, c.point.locationId);
      await recordMovement(tx, { type: "PENYESUAIAN", itemId: c.bahan, qty: have + 7, fromLocationId: c.point.locationId, increase: false, allowNegative: true, ref: `UJI-MT`, note: "uji minus" }, actor);
      await recordMovement(tx, { type: "PENYESUAIAN", itemId: c.kering, qty: 3, fromLocationId: drv, increase: false, allowNegative: true, ref: `UJI-MT`, note: "uji minus" }, actor);
    });
    const pointBefore = await at(c.bahan, c.point.locationId);
    expect(pointBefore).toBeLessThan(0);
    const whBefore = [await at(c.bahan, (await locationSettings(prisma)).raw!), await at(c.kering, c.wh)];
    const mine = (await planMinusTitik()).filter((r) => [c.bahan, c.kering].includes(r.itemId));
    expect(mine.map((r) => [r.refCode, r.qty]).sort()).toEqual([[`DRV`, -3], [`MT${tag}`, pointBefore]].sort());
    const before = await stockBalances(prisma);
    await applyMinusTitik(actor);
    expect(await planMinusTitik()).toHaveLength(0);
    expect(await at(c.bahan, c.point.locationId)).toBe(0);
    expect(await at(c.kering, drv)).toBe(0);
    expect([await at(c.bahan, (await locationSettings(prisma)).raw!), await at(c.kering, c.wh)]).toEqual(whBefore);
    expect(await prisma.stockMovement.count({ where: { ref: `OPT:MT${tag}`, itemId: c.bahan } })).toBeGreaterThanOrEqual(1);
    // Saldo yang tadinya plus tidak berubah
    const afterMap = new Map((await stockBalances(prisma)).map((b) => [`${b.itemId}|${b.locationId}`, b.qty]));
    for (const b of before.filter((x) => x.qty > 0.0005)) expect(afterMap.get(`${b.itemId}|${b.locationId}`)).toBe(b.qty);
    const again = await applyMinusTitik(actor);
    expect(again.rows).toHaveLength(0);
  });

  it("fisik dari laporan shift: angka dari stok akhir laporan Packing terkirim; barang yang tidak ada di laporan tidak diisi", async () => {
    const pack = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const sh = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const a = await saveItemRecord({ name: `Single Pack A ${tag}`, type: "BARANG_JADI", category: "Mainan Gypsum", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 0, divisionId: pack.id }, actor);
    const b = await saveItemRecord({ name: `Single Pack B ${tag}`, type: "BARANG_JADI", category: "Mainan Gypsum", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 0, divisionId: pack.id }, actor);
    const bahan = await saveItemRecord({ name: `Bahan Pack ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 0, divisionId: pack.id }, actor);
    await prisma.shiftReport.create({ data: { date: dateOnly("2027-02-01"), shiftId: sh.id, divisionId: pack.id, createdBy: "uji", status: "TERKIRIM", stockCount: [{ itemId: bahan.id, name: "B", unit: "pcs", limit: 0, qty: 12 }], work: { [RESULT_KEY]: { [a.id]: 340 } } } });
    for (const spec of ["2027-02-01:S1", "2027-02-01:1", "2027-02-01:Shift 1"]) {
      const f = await fisikDariLaporan(spec);
      expect(f.counts.get(a.id)).toBe(340);
      expect(f.counts.get(bahan.id)).toBe(12);
      expect(f.counts.has(b.id)).toBe(false); // tidak ada di laporan → tidak diisi
    }
    await expect(fisikDariLaporan("2027-02-02:S1")).rejects.toThrow(/Tidak ada laporan/);
    await expect(fisikDariLaporan("ngawur")).rejects.toThrow(/YYYY-MM-DD/);
    // Laporan yang masih draf tidak dipakai
    await prisma.shiftReport.create({ data: { date: dateOnly("2027-02-03"), shiftId: sh.id, divisionId: pack.id, createdBy: "uji", status: "DRAFT", work: { [RESULT_KEY]: { [a.id]: 1 } } } });
    await expect(fisikDariLaporan("2027-02-03:S1")).rejects.toThrow(/Tidak ada laporan/);
  });
});
