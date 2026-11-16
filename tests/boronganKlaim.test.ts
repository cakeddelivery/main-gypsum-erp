import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { cancelSettlement, ratesFor, savePerson, settlePoint, type Scope } from "@/lib/borongan";
import { canReceive, canShipGroup, completeShipment, createKeringDraft, createPickup, createShipment, receivePickup, saveAllots } from "@/lib/boronganFlow";
import { stockBalances } from "@/lib/stock";
import { CLAIM_EVERY, approveClaim, assemblingCount, autoClaims, canRequestClaim, claimBreakdown, rejectClaim, requestClaim } from "@/lib/boronganClaim";
import { saveItemRecord } from "@/lib/items";
import { sendPush } from "@/lib/push";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, pointIds: [], personId: null, taskIds: null };

describe("Rincian klaim upah (contoh BMR dari pratinjau)", () => {
  it("pekerja, koordinator, fee driver (selalu ada), total", () => {
    const p = (id: string) => ({ id, name: id });
    const asm = (worker: string, task: string, qty: number) => ({ qty, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, task: { name: `Assembling ${task}` }, worker: p(worker), coordinator: p("Koordinator BMR"), driver: p("Pak Driver") });
    const b = claimBreakdown([
      asm("Icuk", "Hewan", 495), asm("Icuk", "Transportasi", 298), asm("Sumini", "Cowok", 980), asm("Sunny", "Cewek", 785),
      { qty: 118, workerRate: 80n, coordinatorRate: 20n, driverRate: 0n, task: { name: "Cat giftbox" }, worker: p("Mbak Rika"), coordinator: p("Koordinator BMR"), driver: p("Pak Driver") },
    ]);
    expect(b.workers.find((w) => w.name === "Icuk")?.total).toBe(23_790);
    expect(b.totals).toEqual({ workers: 86_180, coordinators: 40_730, drivers: 38_370, all: 165_280 });
    expect(b.coordinators[0].lines).toEqual([{ label: "Assembling (semua pekerja)", qty: 2558, rate: 15, amount: 38_370 }, { label: "Cat Giftbox (semua pekerja)", qty: 118, rate: 20, amount: 2360 }]);
    // Fee driver Cat Giftbox Rp0 tetap tampil
    expect(b.drivers[0].lines.map((l) => [l.qty, l.rate])).toEqual([[2558, 15], [118, 0]]);
    // Reject tidak ada di rincian (upah dari setoran bagus saja); diantar langsung → baris fee driver Rp0
    const direct = claimBreakdown([{ ...asm("Bu Sri", "Cowok", 10), driver: null }]);
    expect(direct.drivers).toEqual([{ id: "-", name: "Tanpa driver (diantar langsung)", lines: [{ label: "Assembling", qty: 10, rate: 0, amount: 0 }], total: 0 }]);
  });

  it("akses Klaim Upah Sekarang", () => {
    const coord: Scope = { all: false, pointIds: ["P1"], personId: "c1", taskIds: null };
    const team: Scope = { all: false, pointIds: ["P1", "P2"], personId: null, taskIds: ["t"], division: { id: "d", captain: true }, warehouse: true };
    expect(canRequestClaim(coord, "P1", true)).toBe(true);
    expect(canRequestClaim(coord, "P2", true)).toBe(false);
    expect(canRequestClaim(all, "P1", true)).toBe(false); // hanya koordinator titik itu
    expect(canRequestClaim(team, "P1", true)).toBe(false);
    expect(canRequestClaim(team, "P2", false)).toBe(true); // Beringin: tim Assembling
    expect(canRequestClaim(all, "P2", false)).toBe(true);
  });
});

describe("Klaim upah di database", () => {
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  let actor: { id: string; name: string };
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `KL${tag}`, name: `Klaim ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LK${tag}`, name: `Titik Klaim ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `K${tag}`, name: `Klaim ${tag}`, locationId: loc.id } });
    const item = (name: string, openingQty = 0) => saveItemRecord({ name: `${name} ${tag}`, type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const kering = await item("Kering Klaim", 500);
    const pot = await item("Pot Klaim", 100);
    const asm = await prisma.pieceTask.create({ data: { code: `AK${tag}`, name: `Assembling ${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, inputs: { create: [{ itemId: kering.id, qty: 1 }] } } });
    const cg = await prisma.pieceTask.create({ data: { code: `CK${tag}`, name: `Pewarnaan pot ${tag}`, divisionId: div.id, ratePerPcs: 100n, workerRate: 80n, coordinatorRate: 20n, driverRate: 0n, inputs: { create: [{ itemId: pot.id, qty: 1 }] } } });
    const coord = await savePerson({ name: `Koor ${tag}`, role: "KOORDINATOR", pointId: point.id }, actor, all);
    const driver = await savePerson({ name: `Drv ${tag}`, role: "DRIVER" }, actor, all);
    const w = await savePerson({ name: `Pekerja ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const bank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
    return { div, point, asm, cg, coord, driver, w, bank, coordScope: { all: false, pointIds: [point.id], personId: coord.id, taskIds: null } as Scope, divScope: { all: false, pointIds: [point.id], personId: null, taskIds: [asm.id, cg.id], division: { id: div.id, captain: true } } as Scope };
  }
  /** Assembling: Cetak/Oven isi patung kering → Assembling/Supervisor lengkapi; pekerjaan lain dikirim langsung */
  async function kirim(taskId: string, qty: number, day: string) {
    if (taskId !== ctx.asm.id) return createShipment({ date: day, mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id, tasks: [{ taskId, qty }] }, actor, all);
    const d = await createKeringDraft({ date: day, tasks: [{ taskId, qty }] }, actor, all);
    return completeShipment(d.id, { date: day, mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id }, actor, all);
  }
  /** Setoran Assembling diterima tim Packing; pekerjaan lain oleh divisi tugasnya */
  const packScope: Scope = { all: false, pointIds: [], personId: null, taskIds: [], division: { id: "packing", captain: true, template: "PACKING" }, packing: true };
  const recv = (taskId: string) => (taskId === ctx.asm.id ? packScope : ctx.divScope);
  /** Satu setoran diterima divisi: kirim → bagi → ambil (selesai) → terima cocok */
  async function setoran(taskId: string, qty: number, day: string) {
    const s = await kirim(taskId, qty, day);
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId, qty }], actor, all);
    const p = await createPickup(s.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId, qty, done: true }], actor, all, day);
    return receivePickup(p.id, [{ taskId, qty }], actor, recv(taskId));
  }

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await prisma.boronganPoint.update({ where: { id: ctx.point.id }, data: { active: false } });
    await prisma.pieceTask.updateMany({ where: { id: { in: [ctx.asm.id, ctx.cg.id] } }, data: { active: false } });
  });

  it("siap otomatis tiap 7× setoran Assembling; Cat Giftbox tidak dihitung tapi ikut klaim; setujui → bayar sekali", async () => {
    for (let i = 1; i <= CLAIM_EVERY - 1; i++) {
      await setoran(ctx.asm.id, 10, `2027-06-${String(i).padStart(2, "0")}`);
      expect(await autoClaims([ctx.point.id])).toEqual([]);
    }
    // Cat Giftbox tidak menambah hitungan 7×
    await setoran(ctx.cg.id, 5, "2027-06-07");
    expect(await assemblingCount(prisma, ctx.point.id)).toBe(CLAIM_EVERY - 1);
    expect(await autoClaims([ctx.point.id])).toEqual([]);
    await setoran(ctx.asm.id, 10, "2027-06-08");
    const [claim] = await autoClaims([ctx.point.id]);
    expect(claim.auto).toBe(true);
    expect(claim.number).toMatch(new RegExp(`^KLM-\\d{6}-K${tag}$`));
    // 70 Assembling × (30+15+15) + 5 Cat Giftbox × (80+20+0)
    expect(Number(claim.total)).toBe(70 * 60 + 5 * 100);
    expect(await assemblingCount(prisma, ctx.point.id)).toBe(0);
    // Setoran yang sudah masuk klaim tidak ikut Bayar Upah per tanggal
    await expect(settlePoint({ pointId: ctx.point.id, upTo: new Date("2030-01-01"), bankAccountId: ctx.bank }, actor)).rejects.toThrow(/Tidak ada upah/);

    // Dua persetujuan bersamaan → hanya satu yang membayar
    const both = await Promise.allSettled([approveClaim(claim.id, ctx.bank, actor), approveClaim(claim.id, ctx.bank, actor)]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const paid = await prisma.boronganClaim.findUniqueOrThrow({ where: { id: claim.id }, include: { settlement: true } });
    expect(paid.status).toBe("DIBAYAR");
    expect(Number(paid.settlement!.total)).toBe(4700);
    expect(await prisma.boronganSettlement.count({ where: { claim: { id: claim.id } } })).toBe(1);
    const unpaid = await prisma.boronganResult.count({ where: { claimId: claim.id, settlementId: null } });
    expect(unpaid).toBe(0);

    // Pembayaran dibatalkan → klaim kembali menunggu, bisa disetujui lagi
    await cancelSettlement(paid.settlementId!, "salah rekening", actor);
    expect((await prisma.boronganClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("MENUNGGU");
    await approveClaim(claim.id, ctx.bank, actor);
    expect((await prisma.boronganClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("DIBAYAR");
  });

  it("Klaim Upah Sekarang hanya koordinator; ditolak → setoran bisa diklaim lagi", async () => {
    await setoran(ctx.asm.id, 4, "2027-06-10");
    await expect(requestClaim(ctx.point.id, actor, ctx.divScope)).rejects.toThrow(/koordinator/);
    await expect(requestClaim(ctx.point.id, actor, all)).rejects.toThrow(/koordinator/);
    const c = await requestClaim(ctx.point.id, actor, ctx.coordScope);
    expect([c.auto, Number(c.total)]).toEqual([false, 240]);
    await expect(requestClaim(ctx.point.id, actor, ctx.coordScope)).rejects.toThrow(/Belum ada upah/);
    await expect(rejectClaim(c.id, " ", actor)).rejects.toThrow(/Alasan/);
    await rejectClaim(c.id, "Cek ulang jumlah", actor);
    expect(await prisma.boronganResult.count({ where: { claimId: c.id } })).toBe(0);
    await expect(approveClaim(c.id, ctx.bank, actor)).rejects.toThrow(/ditolak/);
    const again = await requestClaim(ctx.point.id, actor, ctx.coordScope);
    expect(Number(again.total)).toBe(240);
  });

  it("upah ditahan tidak ikut klaim", async () => {
    const s = await kirim(ctx.asm.id, 5, "2027-06-11");
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 5 }], actor, all);
    const p = await createPickup(s.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 5, done: true }], actor, all, "2027-06-11");
    expect((await receivePickup(p.id, [{ taskId: ctx.asm.id, qty: 3 }], actor, packScope)).short).toBe(true);
    await expect(requestClaim(ctx.point.id, actor, ctx.coordScope)).rejects.toThrow(/Belum ada upah/);
  });

  it("tanpa koordinator → bagian koordinator dibayarkan ke pekerja (Cat Plastik Rp13 + Rp2 = Rp15)", async () => {
    expect(ratesFor({ workerRate: 13n, coordinatorRate: 2n, driverRate: 0n }, null)).toEqual({ workerRate: 15n, coordinatorRate: 0n, driverRate: 0n });
    expect(ratesFor({ workerRate: 13n, coordinatorRate: 2n, driverRate: 0n }, "k1")).toEqual({ workerRate: 13n, coordinatorRate: 2n, driverRate: 0n });
    // Pekerja dipilih tanpa koordinator walau titiknya punya koordinator
    const solo = await savePerson({ name: `Solo ${tag}`, role: "PEKERJA", pointId: ctx.point.id, coordinatorId: "-" }, actor, all);
    expect(solo.noCoordinator).toBe(true);
    const s = await kirim(ctx.asm.id, 4, "2027-06-12");
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: solo.id, taskId: ctx.asm.id, qty: 2 }, { pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 2 }], actor, all);
    const p = await createPickup(s.id, [{ pointId: ctx.point.id, workerId: solo.id, taskId: ctx.asm.id, qty: 2, done: true }, { pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 2, done: true }], actor, all, "2027-06-12");
    await receivePickup(p.id, [{ taskId: ctx.asm.id, qty: 4 }], actor, packScope);
    const rs = await prisma.boronganResult.findMany({ where: { pickupId: p.id } });
    const of = (id: string) => rs.find((r) => r.workerId === id)!;
    expect([of(solo.id).workerRate, of(solo.id).coordinatorRate, of(solo.id).coordinatorId].map((x) => (typeof x === "bigint" ? Number(x) : x))).toEqual([45, 0, null]);
    expect([of(ctx.w.id).workerRate, of(ctx.w.id).coordinatorRate, of(ctx.w.id).coordinatorId].map((x) => (typeof x === "bigint" ? Number(x) : x))).toEqual([30, 15, ctx.coord.id]);
    // Pilihan koordinator lain (aktif) dipakai; koordinator tidak aktif ditolak
    await expect(savePerson({ id: solo.id, name: solo.name, role: "PEKERJA", pointId: ctx.point.id, coordinatorId: ctx.w.id }, actor, all)).rejects.toThrow(/Koordinator tidak aktif/);
  });


  it("koordinator dapat push saat kiriman bahan disimpan dan saat pembagian disimpan", async () => {
    const u = await prisma.user.create({ data: { username: `koor${tag.toLowerCase()}`, name: `Koor ${tag}`, role: "KOORDINATOR", passwordHash: "x" } });
    await prisma.boronganPerson.update({ where: { id: ctx.coord.id }, data: { userId: u.id } });
    vi.mocked(sendPush).mockClear();
    const s = await kirim(ctx.asm.id, 3, "2027-06-13");
    expect(vi.mocked(sendPush).mock.calls.some(([ids, p]) => ids.includes(u.id) && p.title.includes(s.number))).toBe(true);
    vi.mocked(sendPush).mockClear();
    await saveAllots(s.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 3 }], actor, all);
    expect(vi.mocked(sendPush).mock.calls.some(([ids, p]) => ids.includes(u.id) && p.title.includes("sudah dibagi"))).toBe(true);
  });


  it("Assembling bertahap: Cetak/Oven isi patung kering → Assembling lengkapi (stok baru keluar) → Packing terima", async () => {
    const kering: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [], division: { id: "cetak", captain: false, template: "CETAK" }, kering: true };
    const asmTeam: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [ctx.asm.id], division: { id: ctx.div.id, captain: true, template: "ASSEMBLING" } };
    const giftbox: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [], division: { id: "gb", captain: true, template: "GIFTBOX" } };
    // Siapa boleh kirim langsung per jenis
    expect(canShipGroup(asmTeam, "Cat Plastik")).toBe(true);
    expect(canShipGroup(giftbox, "Cat Plastik")).toBe(false);
    expect(canShipGroup(giftbox, "Cat Giftbox")).toBe(true);
    expect(canShipGroup(all, "Assembling")).toBe(false); // selalu lewat isian patung kering
    await expect(createShipment({ date: "2027-06-14", mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id, tasks: [{ taskId: ctx.asm.id, qty: 2 }] }, actor, all)).rejects.toThrow(/Cetak\/Oven/);
    // Langkah 1: tim Cetak/Oven; tim Assembling tidak bisa mengisi patung kering
    await expect(createKeringDraft({ date: "2027-06-14", tasks: [{ taskId: ctx.asm.id, qty: 2 }] }, actor, asmTeam)).rejects.toThrow(/Cetak \/ Oven/);
    const keringItem = (await prisma.pieceTaskInput.findFirstOrThrow({ where: { taskId: ctx.asm.id } })).itemId;
    const wip = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_wip" } })).value;
    const qtyAt = async () => (await stockBalances(prisma, keringItem)).find((b) => b.locationId === wip)?.qty ?? 0;
    const before = await qtyAt();
    const d = await createKeringDraft({ date: "2027-06-14", tasks: [{ taskId: ctx.asm.id, qty: 2 }] }, actor, kering);
    expect([d.waitingSupport, d.pointIds]).toEqual([true, []]);
    expect(await qtyAt()).toBe(before); // stok belum keluar
    await expect(saveAllots(d.id, [{ pointId: ctx.point.id, workerId: ctx.w.id, taskId: ctx.asm.id, qty: 2 }], actor, all)).rejects.toThrow(/menunggu bahan pendukung/);
    // Langkah 2: tim Cetak tidak boleh melengkapi; tim Assembling melengkapi → stok keluar
    await expect(completeShipment(d.id, { mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id }, actor, kering)).rejects.toThrow(/Assembling \/ Supervisor/);
    const done = await completeShipment(d.id, { date: "2027-06-14", mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id }, actor, asmTeam);
    expect([done.waitingSupport, done.pointIds, done.completedBy]).toEqual([false, [ctx.point.id], actor.name]);
    expect(await qtyAt()).toBe(before - 2);
    await expect(completeShipment(d.id, { mode: "DRIVER", pointIds: [ctx.point.id], driverId: ctx.driver.id }, actor, asmTeam)).rejects.toThrow(/sudah dikirim/);
    // Penerimaan setoran Assembling: tim Packing, bukan tim Assembling
    expect(canReceive(asmTeam, [{ name: ctx.asm.name, divisionId: ctx.div.id }])).toBe(false);
    expect(canReceive(packScope, [{ name: ctx.asm.name, divisionId: ctx.div.id }])).toBe(true);
    expect(canReceive(packScope, [{ name: ctx.cg.name, divisionId: ctx.div.id }])).toBe(false);
  });

});
