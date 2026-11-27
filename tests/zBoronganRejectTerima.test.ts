import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { createPickup, createShipment, receivePickup, saveAllots, shipmentView, syncPickupReject } from "@/lib/boronganFlow";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";
import { locationSettings } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

describe("Reject saat diterima divisi: dicatat, upah & klaim tidak berubah", () => {
  let actor: { id: string; name: string };
  let prevFlow: string | undefined;
  const c = {} as { point: { id: string; locationId: string }; task: string; out: string; driver: string; w: string; wh: string };

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    prevFlow = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value;
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const div = await prisma.division.create({ data: { code: `RT${tag}`, name: `Terima RT ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LRT${tag}`, name: `Titik RT ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `RT${tag}`, name: `Titik RT ${tag}`, locationId: loc.id } });
    const item = (name: string, openingQty: number) => saveItemRecord({ name: `${name} ${tag}`, type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kering = await item("Kering RT", 1000);
    const out = await item("Jadi RT", 0);
    const task = await prisma.pieceTask.create({ data: { code: `RTC${tag}`, name: `RakitRT${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: out.id, inputs: { create: [{ itemId: kering.id, qty: 1 }] } } });
    const driver = await savePerson({ name: `Driver RT ${tag}`, role: "DRIVER" }, actor, all);
    const w = await savePerson({ name: `A RT ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wh = (await locationSettings(prisma)).wip!;
    Object.assign(c, { point, task: task.id, out: out.id, driver: driver.id, w: w.id, wh });
  });
  afterAll(async () => {
    if (prevFlow === undefined) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
    else await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: prevFlow } });
    await prisma.boronganPerson.updateMany({ where: { pointId: c.point.id }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: c.point.id }, data: { active: false } });
    await prisma.pieceTask.update({ where: { id: c.task }, data: { active: false } });
  });

  /** Kirim 100 → bagi → ambil → diterima divisi dengan hitungan tertentu */
  async function terima(counted: number, reject?: number) {
    const driverScope: Scope = { all: false, pointIds: [c.point.id], personId: c.driver, taskIds: null, driver: true };
    const s = await createShipment({ date: "2026-11-27", mode: "DRIVER", pointIds: [c.point.id], driverId: c.driver, tasks: [{ taskId: c.task, qty: 100 }] }, actor, all);
    await saveAllots(s.id, [{ pointId: c.point.id, workerId: c.w, taskId: c.task, qty: 100 }], actor, driverScope);
    const pk = await createPickup(s.id, [{ pointId: c.point.id, workerId: c.w, taskId: c.task, qty: 100, done: true }], actor, all);
    const r = await receivePickup(pk.id, [{ taskId: c.task, qty: counted, ...(reject === undefined ? {} : { reject }) }], actor, all);
    const results = await prisma.boronganResult.findMany({ where: { pickupId: pk.id } });
    return { s, pk, r, results, wage: results.reduce((a, x) => a + x.qty * Number(x.workerRate + x.coordinatorRate + x.driverRate), 0), held: results.some((x) => x.held) };
  }

  it("upah sama dengan tanpa reject; reject 5 + bagus 95 tidak membuat upah ditahan; stok bagus 95 ke gudang, reject 5 keluar dari titik ke beban reject", async () => {
    const wh0 = await at(c.out, c.wh);
    const base = await terima(100);
    expect([base.r.short, base.held]).toEqual([false, false]);
    expect(await at(c.out, c.wh)).toBe(wh0 + 100);

    const wh1 = await at(c.out, c.wh);
    const pt1 = await at(c.out, c.point.locationId);
    const rej = await terima(95, 5);
    expect(rej.r.short).toBe(false); // bagus + reject = setoran driver → tidak ditahan
    expect(rej.held).toBe(false);
    expect(rej.wage).toBe(base.wage); // upah sama persis dengan tanpa reject
    expect(await at(c.out, c.wh)).toBe(wh1 + 95); // hanya yang bagus masuk gudang
    expect(await at(c.out, c.point.locationId)).toBe(pt1 + 100 - 95 - 5); // 100 hasil titik, 95 pindah, 5 reject keluar
    const mv = await prisma.stockMovement.findMany({ where: { ref: { startsWith: `RJP:${rej.pk.number}:` } } });
    expect(mv).toHaveLength(1);
    expect([mv[0].type, Number(mv[0].qty), mv[0].journalId != null]).toEqual(["PENYESUAIAN", 5, true]); // beban reject produksi
    const cnt = await prisma.boronganPickupCount.findFirstOrThrow({ where: { pickupId: rej.pk.id } });
    expect([cnt.qty, cnt.reject]).toEqual([95, 5]);
    // Tampil di detail kiriman (view)
    const v = (await shipmentView(rej.s.id))!;
    expect(v.pickups[0].counts).toEqual([{ taskId: c.task, qty: 95, reject: 5 }]);
  });

  it("tanpa reject dan bagus kurang → tetap ditahan seperti sebelumnya; sakelar mati → reject hanya dicatat (tanpa mutasi/jurnal)", async () => {
    const short = await terima(95);
    expect(short.r.short).toBe(true);
    expect(short.held).toBe(true);

    await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
    try {
      const off = await terima(97, 3);
      expect(off.held).toBe(false);
      expect(await prisma.stockMovement.count({ where: { ref: { startsWith: `RJP:${off.pk.number}:` } } })).toBe(0);
      expect((await prisma.boronganPickupCount.findFirstOrThrow({ where: { pickupId: off.pk.id } })).reject).toBe(3);
    } finally {
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "true" } });
    }
  });

  it("idempoten: sinkron ulang tidak menggandakan stok/jurnal; perubahan reject membalik versi lama", async () => {
    const x = await terima(94, 6);
    const stock = async () => ({ pt: await at(c.out, c.point.locationId), wh: await at(c.out, c.wh) });
    const before = await stock();
    const journalsBefore = await prisma.journal.count();
    for (let i = 0; i < 2; i++) await prisma.$transaction((tx) => syncPickupReject(tx, x.pk.id, actor));
    expect(await stock()).toEqual(before);
    // Setiap sinkron membalik versi lama lalu memposting ulang: bersih satu versi aktif
    const refs = [...new Set((await prisma.stockMovement.findMany({ where: { ref: { startsWith: `RJP:${x.pk.number}:` } } })).map((m) => m.ref!))];
    const live = [];
    for (const ref of refs) if (!(await prisma.stockMovement.count({ where: { ref: `BATAL-${ref}` } }))) live.push(ref);
    expect(live).toHaveLength(1);
    expect(await prisma.journal.count()).toBeGreaterThanOrEqual(journalsBefore);
    // Reject diubah 6 → 2: stok titik naik 4 (reject lama dibalik), hanya 2 yang dibuang
    await prisma.boronganPickupCount.updateMany({ where: { pickupId: x.pk.id }, data: { reject: 2 } });
    await prisma.$transaction((tx) => syncPickupReject(tx, x.pk.id, actor));
    expect(await at(c.out, c.point.locationId)).toBe(before.pt + 4);
    expect(await at(c.out, c.wh)).toBe(before.wh);
  });
});
