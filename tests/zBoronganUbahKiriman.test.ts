import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { cancelShipment, canSeeShipment, createShipment, saveAllots, shipmentView, updateShipment } from "@/lib/boronganFlow";
import { shipmentHistory } from "@/lib/boronganHistory";
import { saveItemRecord } from "@/lib/items";
import { saveTaskKit } from "@/lib/boronganSetup";
import { stockBalances } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const supervisor: Scope = { all: true, owner: false, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

describe("Ubah semua data kiriman (Kirim Cat) + hak lihat detail", () => {
  let actor: { id: string; name: string };
  const c = {} as { p1: { id: string; locationId: string }; p2: { id: string; locationId: string }; task: string; cat: string; plastik: string; klip: string; driver: string; drv: string; raw: string; wA: string; div: string };
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `UK${tag}`, name: `Cat ${tag}` } });
    const mkPoint = async (code: string) => {
      const loc = await prisma.location.create({ data: { code: `LUK${code}${tag}`, name: `Titik ${code}${tag}` } });
      return prisma.boronganPoint.create({ data: { code: `${code}${tag}`, name: `Titik ${code}${tag}`, locationId: loc.id, viaDriver: false } });
    };
    const p1 = await mkPoint("A");
    const p2 = await mkPoint("B");
    const item = (name: string, openingQty: number) => saveItemRecord({ name: `${name} ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const cat = await item("Cat uji", 100);
    const plastik = await item("Plastik uji", 50);
    const klip = await item("Klip uji", 50);
    const task = await prisma.pieceTask.create({ data: { code: `UK${tag}`, name: `Catuji${tag} merah`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n, inputs: { create: [{ itemId: cat.id, qty: 1 }] } } });
    await saveTaskKit(prisma, task.id, [plastik.id, klip.id]);
    const driver = await savePerson({ name: `Edy ${tag}`, role: "DRIVER" }, actor, all);
    const wA = await savePerson({ name: `Pekerja ${tag}`, role: "PEKERJA", pointId: p1.id }, actor, all);
    const drv = (await prisma.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value ?? (await prisma.location.findUniqueOrThrow({ where: { code: "DRV" } })).id;
    const raw = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_raw" } })).value;
    Object.assign(c, { p1, p2, task: task.id, cat: cat.id, plastik: plastik.id, klip: klip.id, driver: driver.id, drv, raw, wA: wA.id, div: div.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: { in: [c.p1.id, c.p2.id] } }, data: { active: false } });
    await prisma.boronganPoint.updateMany({ where: { id: { in: [c.p1.id, c.p2.id] } }, data: { active: false } });
    await prisma.pieceTask.update({ where: { id: c.task }, data: { active: false } });
  });
  const mk = async (mode: "DRIVER" | "LANGSUNG" = "DRIVER") => (await createShipment({ date: "2026-11-22", mode, pointIds: [c.p1.id], driverId: mode === "DRIVER" ? c.driver : null, tasks: [{ taskId: c.task, qty: 10 }], support: [{ itemId: c.plastik, qty: 5 }] }, actor, all));

  it("KRM Cat tercatat 'lewat driver (Edy)' padahal diantar langsung → ubah cara kirim: bahan pindah dari mobil driver ke titik, audit lama→baru", async () => {
    const s = await mk("DRIVER");
    expect(await at(c.cat, c.drv)).toBeGreaterThanOrEqual(10);
    const catAtP1 = await at(c.cat, c.p1.locationId);
    const drvBefore = await at(c.cat, c.drv);
    await expect(updateShipment(s.id, { mode: "LANGSUNG" }, "salah pilih", actor, { all: false, pointIds: [c.p1.id], personId: c.driver, taskIds: null, driver: true })).rejects.toThrow(/Owner \/ Supervisor/);
    await expect(updateShipment(s.id, { mode: "LANGSUNG" }, " ", actor, all)).rejects.toThrow(/alasan/i);
    const r = await updateShipment(s.id, { mode: "LANGSUNG" }, "Beringin diantar langsung, bukan lewat driver", actor, supervisor);
    expect(r.changes.caraKirim).toEqual({ lama: "lewat driver", baru: "diantar langsung" });
    expect(r.changes.driver).toMatchObject({ lama: `Edy ${tag}`, baru: null });
    expect(await at(c.cat, c.drv)).toBe(drvBefore - 10); // keluar dari mobil driver
    expect(await at(c.cat, c.p1.locationId)).toBe(catAtP1 + 10); // masuk titik
    const row = await prisma.boronganShipment.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.mode, row.driverId]).toEqual(["LANGSUNG", null]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: s.id, action: "KIRIMAN_DIUBAH" } });
    expect(log.data).toMatchObject({ alasan: "Beringin diantar langsung, bukan lewat driver", perubahan: { caraKirim: { lama: "lewat driver", baru: "diantar langsung" } } });
    // Riwayat: nilai lama→baru untuk admin, hanya alasan untuk koordinator/driver
    const full = await shipmentHistory(s.id, [], true);
    expect(full[0]).toMatchObject({ label: "Kiriman diubah" });
    expect(full[0].text).toMatch(/Cara kirim: lewat driver → diantar langsung/);
    expect((await shipmentHistory(s.id, [], false))[0].text).toBe("Alasan: Beringin diantar langsung, bukan lewat driver");
    // Kembali ke driver
    await updateShipment(s.id, { mode: "DRIVER", driverId: c.driver }, "balik", actor, all);
    expect(await at(c.cat, c.drv)).toBe(drvBefore);
  });

  it("ubah bahan: kurangi / tambah / hapus / tambah barang kit → stok terkoreksi (selisih saja), baris bahan mengikuti; stok kurang ditolak", async () => {
    const s = await mk("LANGSUNG"); // cat 10 (resep) + plastik 5 → di titik A
    const m0 = await prisma.stockMovement.count({ where: { ref: `KRM:${s.number}` } });
    const raw = { cat: await at(c.cat, c.raw), plastik: await at(c.plastik, c.raw), klip: await at(c.klip, c.raw) };
    const r = await updateShipment(s.id, { lines: [{ itemId: c.cat, qty: 8 }, { itemId: c.klip, qty: 4 }] }, "cat dikurangi, plastik tidak jadi, klip ditambah", actor, all);
    expect(await at(c.cat, c.raw)).toBe(raw.cat + 2); // 2 kembali ke gudang
    expect(await at(c.plastik, c.raw)).toBe(raw.plastik + 5); // dihapus → kembali semua
    expect(await at(c.klip, c.raw)).toBe(raw.klip - 4); // barang baru keluar
    expect(await at(c.klip, c.p1.locationId)).toBe(4);
    expect(await prisma.stockMovement.count({ where: { ref: `KRM:${s.number}` } })).toBe(m0 + 3); // 3 koreksi, mutasi lama tetap
    const lines = (await prisma.boronganShipmentLine.findMany({ where: { shipmentId: s.id } })).map((l) => [l.itemId, Number(l.qty), l.support]).sort();
    expect(lines).toEqual([[c.cat, 8, false], [c.klip, 4, true]].sort());
    expect(Object.keys(r.changes)).toEqual(["bahan"]);
    // bahan di luar resep/kit ditolak; stok gudang tidak cukup ditolak dan tidak ada yang berubah
    const asing = await saveItemRecord({ name: `Asing ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 0, price: 1, openingQty: 5 }, actor);
    await expect(updateShipment(s.id, { lines: [{ itemId: c.cat, qty: 8 }, { itemId: asing.id, qty: 1 }] }, "uji", actor, all)).rejects.toThrow(/bukan resep \/ kit/);
    await expect(updateShipment(s.id, { lines: [{ itemId: c.cat, qty: 8 + raw.cat + 2 + 1 }, { itemId: c.klip, qty: 4 }] }, "terlalu banyak", actor, all)).rejects.toThrow(/tidak cukup|Stok/i);
    expect(await at(c.cat, c.raw)).toBe(raw.cat + 2);
    await expect(updateShipment(s.id, { lines: [] }, "kosong", actor, all)).rejects.toThrow(/minimal satu bahan/i);
  });

  it("pindah titik: bahan kembali dari titik lama lalu keluar ke titik baru; terkunci bila sudah dibagi / upah sudah masuk klaim", async () => {
    const s = await mk("LANGSUNG");
    const r = await updateShipment(s.id, { pointIds: [c.p2.id], date: "2026-11-21", note: "pindah ke B" }, "salah titik", actor, all);
    expect(Object.keys(r.changes).sort()).toEqual(["catatan", "tanggal", "titik"]);
    expect(await at(c.plastik, c.p1.locationId)).toBe(0);
    expect(await at(c.plastik, c.p2.locationId)).toBe(5);
    const row = await prisma.boronganShipment.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.pointIds, row.date.toISOString().slice(0, 10), row.note]).toEqual([[c.p2.id], "2026-11-21", "pindah ke B"]);
    // sudah dibagi ke pekerja → titik tidak bisa diganti
    const s2 = await mk("LANGSUNG");
    await saveAllots(s2.id, [{ pointId: c.p1.id, workerId: c.wA, taskId: c.task, qty: 10 }], actor, all);
    await expect(updateShipment(s2.id, { pointIds: [c.p2.id] }, "uji", actor, all)).rejects.toThrow(/sudah dibagi/);
    // upah sudah masuk klaim → titik/cara kirim/driver terkunci
    const s3 = await mk("LANGSUNG");
    const pk = await prisma.boronganPickup.create({ data: { number: `AMB-UK${tag}`, shipmentId: s3.id, date: new Date("2026-11-22"), status: "DITERIMA", createdBy: "uji" } });
    const claim = await prisma.boronganClaim.create({ data: { number: `KLM-UK${tag}`, pointId: c.p1.id, total: 100n, requestedBy: "uji" } });
    await prisma.boronganResult.create({ data: { number: `HSB-UK${tag}`, pointId: c.p1.id, workerId: c.wA, taskId: c.task, date: new Date("2026-11-22"), qty: 1, workerRate: 13n, coordinatorRate: 0n, driverRate: 0n, createdBy: "uji", pickupId: pk.id, claimId: claim.id } });
    await expect(updateShipment(s3.id, { mode: "DRIVER", driverId: c.driver }, "uji", actor, all)).rejects.toThrow(/klaim atau dibayar/);
    // catatan masih boleh (kiriman belum selesai); tanggal & bahan juga
    expect((await updateShipment(s3.id, { note: "oke" }, "catatan", actor, all)).changes).toHaveProperty("catatan");
  });

  it("kiriman 'hasil diisi saat penerimaan' (Cat Plastik) juga bisa diubah bahannya; jumlah per jenis tidak ada", async () => {
    const free = await prisma.pieceTask.create({ data: { code: `UF${tag}`, name: `Catfree${tag} biru`, divisionId: c.div, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n, resultAtReceipt: true, inputs: { create: [{ itemId: c.cat, qty: 1 }] } } });
    await saveTaskKit(prisma, free.id, [c.plastik, c.klip]);
    const s = await createShipment({ date: "2026-11-22", mode: "LANGSUNG", pointIds: [c.p1.id], tasks: [{ taskId: free.id, qty: 0 }], support: [{ itemId: c.cat, qty: 6 }, { itemId: c.plastik, qty: 2 }] }, actor, all);
    const p1 = { cat: await at(c.cat, c.p1.locationId), plastik: await at(c.plastik, c.p1.locationId) };
    const r = await updateShipment(s.id, { lines: [{ itemId: c.cat, qty: 9 }, { itemId: c.plastik, qty: 1 }], tasks: [{ taskId: free.id, qty: 50 }] }, "tambah cat, kurangi plastik", actor, all);
    expect(await at(c.cat, c.p1.locationId)).toBe(p1.cat + 3);
    expect(await at(c.plastik, c.p1.locationId)).toBe(p1.plastik - 1);
    expect(Object.keys(r.changes)).toEqual(["bahan"]); // jumlah per jenis diabaikan untuk kiriman tanpa jumlah
    expect((await prisma.boronganShipmentTask.findFirstOrThrow({ where: { shipmentId: s.id } })).qty).toBe(0);
    await prisma.pieceTask.update({ where: { id: free.id }, data: { active: false } });
  });

  it("kiriman selesai / ditutup: hanya catatan; dibatalkan ditolak; nilai sama bukan perubahan", async () => {
    const s = await mk("LANGSUNG");
    await prisma.boronganShipment.update({ where: { id: s.id }, data: { closedAt: new Date(), closedBy: "uji" } });
    await expect(updateShipment(s.id, { lines: [{ itemId: c.cat, qty: 9 }] }, "uji", actor, all)).rejects.toThrow(/sudah ditutup: hanya catatan/);
    await expect(updateShipment(s.id, { date: "2026-11-22", note: "tanpa ubah" }, "uji", actor, all).then((r) => Object.keys(r.changes))).resolves.toEqual(["catatan"]); // tanggal sama diabaikan
    const t = await mk("LANGSUNG");
    await cancelShipment(t.id, actor, all);
    await expect(updateShipment(t.id, { note: "x" }, "uji", actor, all)).rejects.toThrow(/dibatalkan/);
  });

  it("batalkan kiriman setelah diubah: semua bahan kembali (termasuk mutasi koreksi)", async () => {
    const before = { cat: await at(c.cat, c.raw), plastik: await at(c.plastik, c.raw), klip: await at(c.klip, c.raw), klipP1: await at(c.klip, c.p1.locationId), catDrv: await at(c.cat, c.drv), catP1: await at(c.cat, c.p1.locationId) };
    const s = await mk("DRIVER");
    await updateShipment(s.id, { mode: "LANGSUNG", lines: [{ itemId: c.cat, qty: 7 }, { itemId: c.klip, qty: 3 }] }, "ubah lalu batal", actor, all);
    await cancelShipment(s.id, actor, all);
    expect(await at(c.cat, c.raw)).toBe(before.cat);
    expect(await at(c.plastik, c.raw)).toBe(before.plastik);
    expect(await at(c.klip, c.raw)).toBe(before.klip);
    expect(await at(c.klip, c.p1.locationId)).toBe(before.klipP1);
    expect(await at(c.cat, c.drv)).toBe(before.catDrv);
    expect(await at(c.cat, c.p1.locationId)).toBe(before.catP1);
  });

  it("hak lihat detail per peran (aturan sama dengan daftar Kiriman)", async () => {
    const s = await mk("DRIVER");
    const v = (await shipmentView(s.id))!;
    const owner: Scope = all;
    const driver: Scope = { all: false, pointIds: [c.p1.id], personId: c.driver, taskIds: null, driver: true };
    const koordA: Scope = { all: false, pointIds: [c.p1.id], personId: "k1", taskIds: null };
    const koordB: Scope = { all: false, pointIds: [c.p2.id], personId: "k2", taskIds: null };
    const divisi: Scope = { all: false, pointIds: [c.p1.id], personId: null, taskIds: [c.task], division: { id: c.div, captain: false } };
    const divisiLain: Scope = { all: false, pointIds: [c.p1.id], personId: null, taskIds: ["lain"], division: { id: "lain", captain: false } };
    const oven: Scope = { all: false, pointIds: [], personId: null, taskIds: [], division: { id: "o", captain: false }, kering: true };
    expect(canSeeShipment(owner, v)).toBe(true);
    expect(canSeeShipment(supervisor, v)).toBe(true);
    expect(canSeeShipment(driver, v)).toBe(true); // kiriman lewat driver
    expect(canSeeShipment(koordA, v)).toBe(true); // titiknya
    expect(canSeeShipment(koordB, v)).toBe(false); // titik lain
    expect(canSeeShipment(divisi, v)).toBe(true);
    expect(canSeeShipment(divisiLain, v)).toBe(false);
    expect(canSeeShipment(oven, v)).toBe(false); // Cetak/Oven hanya kiriman Assembling
    const langsung = (await shipmentView((await mk("LANGSUNG")).id))!;
    expect(canSeeShipment(driver, langsung)).toBe(false); // driver hanya kiriman lewat driver
    // Detail memuat bahan (nama, jumlah, satuan) & jumlah per jenis
    expect(v.lines.find((l) => l.itemId === c.cat)).toMatchObject({ qty: 10, unit: "pcs" });
    expect(v.tasks[0].qty).toBe(10);
  });
});
