import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, unpaidResults, type Scope } from "@/lib/borongan";
import {
  allotStockPlan, autofill, byColumn, cancelShipment, checkCounts, createPickup, createShipment, receivePickup, rejectToAccount, remain, resolvePickup,
  saveAllots, saveWorkReport, shipmentState, shipmentView, shortTaskName, splitByWeights, canDistribute, canReceive, canReport,
} from "@/lib/boronganFlow";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));
import { sendPush } from "@/lib/push";

const all: Scope = { all: true, pointIds: [], personId: null, taskIds: null };

describe("Alur kiriman borongan: hitungan murni", () => {
  it("sisa / selisih dan Selesai semua (isi otomatis)", () => {
    // Dibagi 1.000, diambil sebelumnya 600, reject 20 → selesai semua: setoran otomatis 380, selisih 0
    expect(autofill({ dibagi: 1000, diambil: 600, reject: 20 })).toBe(380);
    expect(remain({ dibagi: 1000, diambil: 600, setoran: 380, reject: 20 })).toBe(0);
    // Driver hanya membawa 370 → selisih 10
    expect(remain({ dibagi: 1000, diambil: 600, setoran: 370, reject: 20 })).toBe(10);
    // Reject lebih besar dari sisa → tidak minus
    expect(autofill({ dibagi: 10, diambil: 8, reject: 5 })).toBe(0);
    expect(rejectToAccount(5, 3)).toBe(2);
    expect(rejectToAccount(3, 5)).toBe(0);
  });

  it("nama kolom pendek per jenis", () => {
    expect(["Assembling Cowok", "Assembling Transportasi", "Cat plastik merah", "Cat giftbox"].map(shortTaskName)).toEqual(["Cowok", "Transport", "Merah", "Cat Giftbox"]);
    expect(byColumn(["Assembling Transportasi", "Assembling Cewek", "Assembling Hewan", "Assembling Cowok"], (x) => x).map(shortTaskName)).toEqual(["Cowok", "Cewek", "Hewan", "Transport"]);
  });

  it("pembagian bobot tepat jumlahnya (sisa terbesar)", () => {
    expect([...splitByWeights(10, [["a", 1], ["b", 1], ["c", 1]])]).toEqual([["a", 4], ["b", 3], ["c", 3]]);
    expect([...splitByWeights(1, [["a", 2], ["b", 1]], 3)]).toEqual([["a", 0.667], ["b", 0.333]]);
    expect(splitByWeights(5, [["a", 0]]).size).toBe(0);
  });

  it("status kiriman & hitungan kurang", () => {
    const allots = [{ workerId: "w1", taskId: "t", qty: 10 }, { workerId: "w2", taskId: "t", qty: 5 }];
    expect(shipmentState(allots, [])).toBe("DI_PEKERJA");
    expect(shipmentState(allots, [{ status: "DITERIMA", lines: [{ workerId: "w1", taskId: "t", done: true }] }])).toBe("SEBAGIAN");
    expect(shipmentState(allots, [{ status: "DITERIMA", lines: [{ workerId: "w1", taskId: "t", done: true }] }, { status: "DIBAWA", lines: [{ workerId: "w2", taskId: "t", done: true }] }])).toBe("SELESAI");
    expect(shipmentState(allots, [{ status: "DIBATALKAN", lines: [{ workerId: "w1", taskId: "t", done: true }] }])).toBe("DI_PEKERJA");
    const c = checkCounts(new Map([["a", 380], ["b", 100]]), new Map([["a", 380], ["b", 98]]));
    expect(c.short).toBe(true);
    expect(c.rows.find((r) => r.taskId === "b")?.diff).toBe(-2);
    expect(checkCounts(new Map([["a", 5]]), new Map([["a", 6]])).short).toBe(false);
  });

  it("stok bahan per titik mengikuti pembagian", () => {
    const plan = allotStockPlan(
      [{ itemId: "keringCowok", qty: 60, support: false }, { itemId: "plastik", qty: 50, support: true }],
      [{ taskId: "cowok", qty: 60, inputs: [{ itemId: "keringCowok", per: 1 }] }, { taskId: "cewek", qty: 40, inputs: [] }],
      [{ pointId: "P1", workerId: "a", taskId: "cowok", qty: 30 }, { pointId: "P1", workerId: "b", taskId: "cewek", qty: 40 }, { pointId: "P2", workerId: "c", taskId: "cowok", qty: 30 }],
    );
    expect(plan.get("P1")?.get("keringCowok")).toBe(30);
    expect(plan.get("P2")?.get("keringCowok")).toBe(30);
    // Bahan pendukung sebanding pcs: P1 70 dari 100, P2 30 dari 100
    expect(plan.get("P1")?.get("plastik")).toBe(35);
    expect(plan.get("P2")?.get("plastik")).toBe(15);
  });
});

describe("Alur kiriman borongan di database", () => {
  let actor: { id: string; name: string };
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `RK${tag}`, name: `Rakit ${tag}` } });
    const mkPoint = async (code: string, viaDriver = true) => {
      const loc = await prisma.location.create({ data: { code: `L${code}`, name: `Titik ${code}` } });
      return prisma.boronganPoint.create({ data: { code, name: `Titik ${code}`, locationId: loc.id, viaDriver } });
    };
    const p1 = await mkPoint(`A${tag}`);
    const p2 = await mkPoint(`B${tag}`);
    const item = (name: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES", openingQty = 0) => saveItemRecord({ name: `${name} ${tag}`, type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const keringCowok = await item("Kering Cowok", "BARANG_DALAM_PROSES", 100);
    const keringCewek = await item("Kering Cewek", "BARANG_DALAM_PROSES", 100);
    const plastik = await item("Plastik Single", "BAHAN_BAKU", 50);
    const jadiCowok = await item("Jadi Cowok", "BARANG_DALAM_PROSES");
    const jadiCewek = await item("Jadi Cewek", "BARANG_DALAM_PROSES");
    const mkTask = (name: string, input: string, output: string) => prisma.pieceTask.create({ data: { code: `T${name.slice(-5)}${tag}`.toUpperCase(), name, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: output, inputs: { create: [{ itemId: input, qty: 1 }] } } });
    const tCowok = await mkTask(`Rakit${tag} Cowok`, keringCowok.id, jadiCowok.id);
    const tCewek = await mkTask(`Rakit${tag} Cewek`, keringCewek.id, jadiCewek.id);
    const coord = await savePerson({ name: `Koordinator ${tag}`, role: "KOORDINATOR", pointId: p1.id }, actor, all);
    const driver = await savePerson({ name: `Driver ${tag}`, role: "DRIVER" }, actor, all);
    const wA = await savePerson({ name: `Icuk ${tag}`, role: "PEKERJA", pointId: p1.id }, actor, all);
    const wB = await savePerson({ name: `Sunny ${tag}`, role: "PEKERJA", pointId: p1.id }, actor, all);
    const wC = await savePerson({ name: `Rini ${tag}`, role: "PEKERJA", pointId: p2.id }, actor, all);
    const locs = Object.fromEntries((await prisma.setting.findMany({ where: { key: { in: ["loc_wip", "loc_raw", "loc_finished"] } } })).map((s) => [s.key, s.value]));
    const drv = (await prisma.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value ?? (await prisma.location.findUniqueOrThrow({ where: { code: "DRV" } })).id;
    return {
      div, p1, p2, keringCowok, keringCewek, plastik, jadiCowok, jadiCewek, tCowok, tCewek, coord, driver, wA, wB, wC, locs, drv,
      coordScope: { all: false, pointIds: [p1.id], personId: coord.id, taskIds: null } as Scope,
      driverScope: { all: false, pointIds: [p1.id, p2.id], personId: driver.id, taskIds: null, driver: true } as Scope,
      divScope: { all: false, pointIds: [p1.id, p2.id], personId: null, taskIds: [tCowok.id, tCewek.id], division: { id: div.id, captain: true } } as Scope,
    };
  }

  beforeAll(async () => {
    ctx = await setup();
  });
  // Titik uji dinonaktifkan agar tidak ikut terhitung di tes lain (titik tanpa pengaturan = semua tugas)
  afterAll(async () => {
    await prisma.boronganPoint.updateMany({ where: { id: { in: [ctx.p1.id, ctx.p2.id] } }, data: { active: false } });
  });

  it("kirim (KRM) → bagi → lapor → ambil bertahap → terima cocok / kurang (upah ditahan) → koreksi", async () => {
    const { p1, p2, tCowok, tCewek, wA, wB, wC, keringCowok, plastik, jadiCowok, locs, drv } = ctx;
    // 1. Kirim bahan lewat driver ke dua titik: bahan resep otomatis + bahan pendukung
    const s = await createShipment({ date: "2027-05-15", mode: "DRIVER", pointIds: [p1.id, p2.id], driverId: ctx.driver.id, tasks: [{ taskId: tCowok.id, qty: 60 }, { taskId: tCewek.id, qty: 40 }], support: [{ itemId: plastik.id, qty: 50 }] }, actor, all);
    expect(s.number).toMatch(/^KRM-150527-\d{2}$/);
    expect(await at(keringCowok.id, locs.loc_wip)).toBe(40);
    expect(await at(keringCowok.id, drv)).toBeGreaterThanOrEqual(60);
    await expect(createShipment({ date: "2027-05-15", mode: "DRIVER", pointIds: [p1.id], driverId: ctx.driver.id, tasks: [{ taskId: tCowok.id, qty: 5 }] }, actor, ctx.coordScope)).rejects.toThrow(/Supervisor/);

    // 2. Pembagian oleh driver (tim divisi tidak boleh untuk kiriman lewat driver)
    expect(canDistribute(ctx.divScope, { mode: "DRIVER", taskIds: [tCowok.id] })).toBe(false);
    await expect(saveAllots(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 61 }], actor, ctx.driverScope)).rejects.toThrow(/melebihi kiriman/);
    const half = await saveAllots(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 30 }], actor, ctx.driverScope);
    expect(half.left).toBe(70); // peringatan sisa belum dibagi
    const allot = await saveAllots(s.id, [
      { pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 30 },
      { pointId: p1.id, workerId: wB.id, taskId: tCewek.id, qty: 40 },
      { pointId: p2.id, workerId: wC.id, taskId: tCowok.id, qty: 30 },
    ], actor, ctx.driverScope);
    expect(allot.left).toBe(0);
    // Bahan pindah dari mobil driver ke titik sesuai pembagian (disimpan ulang tidak dobel)
    expect(await at(keringCowok.id, p1.locationId)).toBe(30);
    expect(await at(keringCowok.id, p2.locationId)).toBe(30);
    expect(await at(plastik.id, p1.locationId)).toBe(35);
    expect(await at(plastik.id, p2.locationId)).toBe(15);

    // 3. Lapor hasil: koordinator titik 1; titik 2 tanpa koordinator → tim divisi
    expect(canReport(ctx.coordScope, { taskIds: [tCowok.id] }, p2.id, false)).toBe(false);
    expect(canReport(ctx.divScope, { taskIds: [tCowok.id] }, p2.id, false)).toBe(true);
    expect(canReport(ctx.divScope, { taskIds: [tCowok.id] }, p1.id, true)).toBe(false);
    await expect(saveWorkReport(s.id, p1.id, [{ workerId: wA.id, taskId: tCowok.id, good: 25, reject: 2 }], false, actor, ctx.coordScope)).rejects.toThrow(/dicek koordinator/);
    await expect(saveWorkReport(s.id, p1.id, [{ workerId: wA.id, taskId: tCowok.id, good: 30, reject: 2 }], true, actor, ctx.coordScope)).rejects.toThrow(/melebihi/);
    await saveWorkReport(s.id, p1.id, [{ workerId: wA.id, taskId: tCowok.id, good: 25, reject: 2 }, { workerId: wB.id, taskId: tCewek.id, good: 40, reject: 0 }], true, actor, ctx.coordScope);

    // 4. Ambil setoran ke-1: Icuk sebagian, Rini selesai (titik 2 belum dilapor: tetap bisa dicatat)
    const amb1 = await createPickup(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 20, done: false }, { pointId: p2.id, workerId: wC.id, taskId: tCowok.id, qty: 30, done: true }], actor, ctx.driverScope, "2027-05-17");
    expect(amb1.number).toMatch(/^AMB-170527-\d{2}$/);
    expect(amb1.driverId).toBe(ctx.driver.id);
    let v = (await shipmentView(s.id))!;
    expect(v.state).toBe("SEBAGIAN");
    expect(v.cells.find((c) => c.workerId === wA.id)).toMatchObject({ dibagi: 30, diambil: 20, good: 25, reject: 2, done: false });
    await expect(createPickup(s.id, [{ pointId: p2.id, workerId: wC.id, taskId: tCowok.id, qty: 1, done: false }], actor, ctx.driverScope)).rejects.toThrow(/sudah selesai/);

    // 5. Terima: divisi penerima menghitung total per jenis → cocok, barang masuk gudang, upah per pekerja = setoran driver
    expect(canReceive(ctx.coordScope, [{ divisionId: ctx.div.id }])).toBe(false);
    const r1 = await receivePickup(amb1.id, [{ taskId: tCowok.id, qty: 50 }], actor, ctx.divScope);
    expect(r1.short).toBe(false);
    expect(await at(jadiCowok.id, locs.loc_wip)).toBe(50);
    const res1 = await prisma.boronganResult.findMany({ where: { pickupId: amb1.id }, orderBy: { qty: "asc" } });
    expect(res1.map((r) => [r.qty, r.reject, r.held, r.coordinatorId != null, r.driverId])).toEqual([[20, 2, false, true, ctx.driver.id], [30, 0, false, false, ctx.driver.id]]);

    // 6. Ambil ke-2 "Selesai semua": setoran Icuk otomatis 30 − 20 − 2 = 8, Sunny 40; driver membawa Icuk 8
    const auto = autofill({ dibagi: 30, diambil: 20, reject: 2 });
    expect(auto).toBe(8);
    vi.mocked(sendPush).mockClear();
    const amb2 = await createPickup(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: auto, done: true }, { pointId: p1.id, workerId: wB.id, taskId: tCewek.id, qty: 40, done: true }], actor, ctx.driverScope, "2027-05-19");
    // Setoran driver Icuk 28 ≠ laporan koordinator 25 → koordinator diberi tahu (bila punya akun)
    expect((await shipmentView(s.id))!.state).toBe("SELESAI");
    // Divisi hanya menghitung 6 Cowok → kurang: upah ditahan, tidak ikut dibayar
    const r2 = await receivePickup(amb2.id, [{ taskId: tCowok.id, qty: 6 }, { taskId: tCewek.id, qty: 40 }], actor, ctx.divScope);
    expect(r2.short).toBe(true);
    expect((await prisma.boronganPickup.findUniqueOrThrow({ where: { id: amb2.id } })).status).toBe("KURANG");
    const held = await prisma.boronganResult.findMany({ where: { pickupId: amb2.id } });
    expect(held.every((r) => r.held)).toBe(true);
    const unpaid = await unpaidResults(prisma, p1.id);
    expect(unpaid.some((r) => r.pickupId === amb2.id)).toBe(false);
    expect(unpaid.some((r) => r.pickupId === amb1.id)).toBe(true);
    await expect(receivePickup(amb2.id, [{ taskId: tCowok.id, qty: 8 }, { taskId: tCewek.id, qty: 40 }], actor, ctx.divScope)).rejects.toThrow(/sudah diproses/);

    // 7. Supervisor mengoreksi setoran driver Icuk menjadi 6 → cocok, upah dilepas
    await expect(resolvePickup(amb2.id, { reason: "cek" }, actor, ctx.divScope)).rejects.toThrow(/Supervisor/);
    const lineA = (await prisma.boronganPickupLine.findFirstOrThrow({ where: { pickupId: amb2.id, workerId: wA.id } })).id;
    const fix = await resolvePickup(amb2.id, { reason: "Driver salah hitung", lines: [{ id: lineA, qty: 6 }] }, actor, all);
    expect(fix.short).toBe(false);
    const after = await prisma.boronganResult.findMany({ where: { pickupId: amb2.id } });
    expect(after.every((r) => !r.held)).toBe(true);
    expect(after.find((r) => r.workerId === wA.id)?.qty).toBe(6);
    expect((await prisma.boronganPickup.findUniqueOrThrow({ where: { id: amb2.id } })).status).toBe("DITERIMA");
    expect(await at(jadiCowok.id, locs.loc_wip)).toBe(56);

    // Ringkasan kiriman: dikirim 100, diterima 20 + 30 + 6 + 40 = 96, reject 2 → selisih 2 (Icuk)
    v = (await shipmentView(s.id))!;
    expect(v.totals).toMatchObject({ sent: 100, received: 96, reject: 2, gap: 2 });
    await expect(cancelShipment(s.id, actor, all)).rejects.toThrow(/sudah diambil/);
  });

  it("lepas tahanan dengan alasan; kiriman diantar langsung hanya satu titik; batal kiriman mengembalikan bahan", async () => {
    const { p1, p2, tCowok, wA, keringCowok, locs } = ctx;
    await expect(createShipment({ date: "2027-05-20", mode: "LANGSUNG", pointIds: [p1.id, p2.id], tasks: [{ taskId: tCowok.id, qty: 5 }] }, actor, all)).rejects.toThrow(/satu titik/);
    const before = await at(keringCowok.id, locs.loc_wip);
    const s = await createShipment({ date: "2027-05-20", mode: "LANGSUNG", pointIds: [p1.id], tasks: [{ taskId: tCowok.id, qty: 5 }] }, actor, all);
    expect(await at(keringCowok.id, locs.loc_wip)).toBe(before - 5);
    // Diantar langsung: tim divisi membagi & mengambil; driver tidak
    expect(canDistribute(ctx.driverScope, { mode: "LANGSUNG", taskIds: [tCowok.id] })).toBe(false);
    await saveAllots(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 5 }], actor, ctx.divScope);
    const amb = await createPickup(s.id, [{ pointId: p1.id, workerId: wA.id, taskId: tCowok.id, qty: 5, done: true }], actor, ctx.divScope, "2027-05-21");
    expect(amb.driverId).toBeNull();
    const r = await receivePickup(amb.id, [{ taskId: tCowok.id, qty: 4 }], actor, ctx.divScope);
    expect(r.short).toBe(true);
    await resolvePickup(amb.id, { reason: "Sudah dicek, 1 pcs jatuh di jalan" }, actor, all);
    expect((await prisma.boronganResult.findMany({ where: { pickupId: amb.id } })).every((x) => !x.held)).toBe(true);

    const s2 = await createShipment({ date: "2027-05-22", mode: "LANGSUNG", pointIds: [p1.id], tasks: [{ taskId: tCowok.id, qty: 7 }] }, actor, all);
    const mid = await at(keringCowok.id, locs.loc_wip);
    await cancelShipment(s2.id, actor, all);
    expect(await at(keringCowok.id, locs.loc_wip)).toBe(mid + 7);
  });
});
