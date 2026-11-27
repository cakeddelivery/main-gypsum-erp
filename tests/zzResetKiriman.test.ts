import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { savePerson, type Scope } from "@/lib/borongan";
import { createPickup, createShipment, receivePickup, saveAllots, saveWorkReport } from "@/lib/boronganFlow";
import { recordDivisionReceipt } from "@/lib/boronganReceipt";
import { addShiftReceipt } from "@/lib/shiftReceipt";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";
import { SALDO_AWAL_REF, collectReset, runReset } from "@/lib/resetKiriman";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
// Baris saldo 0 tidak dihitung (baris hilang saat semua mutasinya terhapus = saldo 0 yang sama)
const snap = async () => new Map((await stockBalances(prisma)).map((b) => [`${b.itemId}|${b.locationId}`, Math.round(b.qty * 1000) / 1000] as const).filter(([, q]) => Math.abs(q) >= 0.0005));

describe("Reset riwayat kiriman & penerimaan tanpa mengubah stok", () => {
  let actor: { id: string; name: string };
  const c = {} as { point: { id: string; locationId: string }; cowok: string; kCowok: string; out: string; wA: string; wB: string; driver: string; div: string; raw: string };
  let paidResult = "";
  let unpaidResult = "";
  let shiftReceiptLinked = "";
  let shiftReceiptFree = "";

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `RK${tag}`, name: `Rakit RK ${tag}`, reportTemplate: "ASSEMBLING" } });
    const loc = await prisma.location.create({ data: { code: `LRK${tag}`, name: `Titik RK ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `RK${tag}`, name: `Titik RK ${tag}`, locationId: loc.id } });
    const item = (name: string, type: "BARANG_DALAM_PROSES" | "BAHAN_BAKU", openingQty: number, divisionId?: string) => saveItemRecord({ name: `${name} ${tag}`, type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty, divisionId }, actor);
    const kCowok = await item("Kering Cowok RK", "BARANG_DALAM_PROSES", 1000);
    const out = await item("Jadi RK", "BARANG_DALAM_PROSES", 0);
    const raw = await item("Bahan RK", "BAHAN_BAKU", 50, div.id);
    const t = await prisma.pieceTask.create({ data: { code: `RKC${tag}`, name: `RakitRK${tag} Cowok`, divisionId: div.id, ratePerPcs: 60n, workerRate: 30n, coordinatorRate: 15n, driverRate: 15n, outputItemId: out.id, inputs: { create: [{ itemId: kCowok.id, qty: 1 }] } } });
    const driver = await savePerson({ name: `Driver RK ${tag}`, role: "DRIVER" }, actor, all);
    const wA = await savePerson({ name: `A RK ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wB = await savePerson({ name: `B RK ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    Object.assign(c, { point, cowok: t.id, kCowok: kCowok.id, out: out.id, wA: wA.id, wB: wB.id, driver: driver.id, div: div.id, raw: raw.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: c.point.id }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: c.point.id }, data: { active: false } });
    await prisma.pieceTask.update({ where: { id: c.cowok }, data: { active: false } });
  });

  it("siapkan: kiriman → bagi → ambil → terima (setoran upah), penerimaan divisi, barang masuk laporan (bebas & tertaut Pembelian)", async () => {
    const driverScope: Scope = { all: false, pointIds: [c.point.id], personId: c.driver, taskIds: null, driver: true };
    const s = await createShipment({ date: "2026-11-26", mode: "DRIVER", pointIds: [c.point.id], driverId: c.driver, tasks: [{ taskId: c.cowok, qty: 100 }] }, actor, all);
    await saveAllots(s.id, [{ pointId: c.point.id, workerId: c.wA, taskId: c.cowok, qty: 60 }, { pointId: c.point.id, workerId: c.wB, taskId: c.cowok, qty: 40 }], actor, driverScope);
    await saveWorkReport(s.id, c.point.id, [{ workerId: c.wA, taskId: c.cowok, good: 60, reject: 0 }, { workerId: c.wB, taskId: c.cowok, good: 40, reject: 0 }], true, actor, all);
    await createPickup(s.id, [{ pointId: c.point.id, workerId: c.wA, taskId: c.cowok, qty: 60, done: true }, { pointId: c.point.id, workerId: c.wB, taskId: c.cowok, qty: 40, done: true }], actor, all);
    const pk = await prisma.boronganPickup.findFirstOrThrow({ where: { shipmentId: s.id } });
    await receivePickup(pk.id, [{ taskId: c.cowok, qty: 100 }], actor, all);
    const results = await prisma.boronganResult.findMany({ where: { pickupId: pk.id }, orderBy: { number: "asc" } });
    expect(results.length).toBe(2);
    // Satu setoran sudah dibayar (settlement), satu belum
    const bank = await prisma.bankAccount.findFirstOrThrow();
    const st = await prisma.boronganSettlement.create({ data: { number: `STL-RK-${tag}`, pointId: c.point.id, date: new Date(), upTo: new Date(), bankAccountId: bank.id, total: 1800n, createdBy: "uji" } });
    await prisma.boronganResult.update({ where: { id: results[0].id }, data: { settlementId: st.id } });
    paidResult = results[0].id;
    unpaidResult = results[1].id;
    // Penerimaan divisi
    await recordDivisionReceipt({ divisionId: c.div, date: new Date("2026-11-26T00:00:00Z"), lines: [{ itemId: c.out, qty: 90, reject: 0 }] }, actor, all);
    // Barang masuk laporan shift: satu bebas, satu tertaut Pembelian
    const sh = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const rep = await prisma.shiftReport.create({ data: { date: new Date("2026-11-26T00:00:00Z"), shiftId: sh.id, divisionId: c.div, createdBy: "uji" } });
    const free = await addShiftReceipt(rep.id, { itemId: c.raw, qty: 5, supplierName: "Toko" }, actor);
    const linked = await addShiftReceipt(rep.id, { itemId: c.raw, qty: 7, supplierName: "Toko" }, actor);
    const sup = await prisma.supplier.findFirstOrThrow();
    const store = await prisma.store.findFirstOrThrow();
    const purchase = await prisma.purchase.create({ data: { number: `PB-RK-${tag}`, storeId: store.id, date: new Date(), vendor: sup.name, term: "LUNAS", createdBy: "uji", total: 0n } as never });
    await prisma.shiftReceipt.update({ where: { id: linked.id }, data: { purchaseId: purchase.id } });
    shiftReceiptFree = free.id;
    shiftReceiptLinked = linked.id;
    expect(await prisma.stockMovement.count({ where: { ref: { startsWith: "KRM:" } } })).toBeGreaterThan(0);
  });

  it("pratinjau tidak mengubah apa pun dan melaporkan yang dilewati", async () => {
    const before = await snap();
    const counts = [await prisma.stockMovement.count(), await prisma.boronganShipment.count(), await prisma.boronganResult.count()];
    const plan = await collectReset(prisma);
    expect(plan.shipments.length).toBeGreaterThan(0);
    expect(plan.resultsDelete).toBeGreaterThan(0);
    expect(plan.shiftReceiptsSkipped.some((x) => x.number)).toBe(true);
    expect(await prisma.stockMovement.count()).toBe(counts[0]);
    expect(await prisma.boronganShipment.count()).toBe(counts[1]);
    expect(await prisma.boronganResult.count()).toBe(counts[2]);
    expect(await snap()).toEqual(before);
  });

  it("jalankan: dokumen kosong, saldo SAMA PERSIS, setoran terbayar & jurnal utuh, barang masuk tertaut tetap", async () => {
    const before = await snap();
    const journals = await prisma.journal.count();
    const lines = await prisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    const r = await runReset({}, actor);
    expect(r.shipments.length).toBeGreaterThan(0);
    // Dokumen kosong
    expect(await prisma.boronganShipment.count()).toBe(0);
    expect(await prisma.boronganPickup.count()).toBe(0);
    expect(await prisma.boronganReceipt.count()).toBe(0);
    expect(await prisma.boronganWorkReport.count()).toBe(0);
    expect(await prisma.boronganAllot.count()).toBe(0);
    expect(await prisma.shiftReceipt.findUnique({ where: { id: shiftReceiptFree } })).toBeNull();
    expect(await prisma.shiftReceipt.findUnique({ where: { id: shiftReceiptLinked } })).not.toBeNull(); // tertaut Pembelian: tidak diputus
    // Setoran: belum dibayar dihapus; yang dibayar tetap, hanya dilepas dari pengambilan
    expect(await prisma.boronganResult.findUnique({ where: { id: unpaidResult } })).toBeNull();
    const paid = await prisma.boronganResult.findUniqueOrThrow({ where: { id: paidResult } });
    expect(paid.pickupId).toBeNull();
    expect(paid.settlementId).not.toBeNull();
    expect(await prisma.boronganSettlement.findUnique({ where: { id: paid.settlementId! } })).not.toBeNull();
    // Jurnal tidak dihapus / tidak berubah
    expect(await prisma.journal.count()).toBe(journals);
    const lines2 = await prisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    expect(lines2._sum).toEqual(lines._sum);
    // Tidak ada mutasi ber-ref dokumen yang dihapus (mutasi ber-awalan sama tanpa dokumen, mis. data lain, tidak disentuh)
    expect(r.refs.length).toBeGreaterThan(0);
    expect(await prisma.stockMovement.count({ where: { ref: { in: r.refs } } })).toBe(0);
    // Saldo semua barang × lokasi identik dengan sebelumnya
    expect(await snap()).toEqual(before);
    expect(await prisma.stockMovement.count({ where: { ref: SALDO_AWAL_REF } })).toBe(r.adjustments);
    expect(await prisma.stockMovement.count({ where: { ref: SALDO_AWAL_REF, journalId: { not: null } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "RESET_KIRIMAN_PENERIMAAN" } })).toBe(1);
  });

  it("aman diulang: tidak ada yang tersisa untuk dihapus dan saldo tetap", async () => {
    const before = await snap();
    const r = await runReset({}, actor);
    expect(r.shipments.length + r.receipts.length + r.resultsDelete).toBe(0);
    expect(await snap()).toEqual(before);
  });
});
