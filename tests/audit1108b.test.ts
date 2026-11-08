import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { finishedGoodsOpname, locationSettings, negativeStock, postProductionStock, qtyAt, recordMovement } from "@/lib/stock";
import { approvePeriod, cancelAdvance, cancelPayment, computePeriod, giveAdvance, payPeriod, unapprovePeriod } from "@/lib/payroll";
import { cancelPurchase, createPurchase } from "@/lib/purchase";
import { effectivePermissions } from "@/lib/rbac";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let seabank: string;
let storeId: string;
const d = (s: string) => jakartaDateTime(s, "10:00");
/** Saldo (debit − kredit) satu akun dari jurnal tertentu */
const net = async (journalIds: string[], code: string) => {
  const ls = await prisma.journalLine.findMany({ where: { journalId: { in: journalIds }, account: { code } } });
  return ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
};

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
});

describe("Audit 8 Nov paket 2: stok & produksi", () => {
  it("reject tahap Cetak langsung dibebankan, tidak mengendap di BDP", async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const e = await prisma.productionEntry.create({ data: { date: dateOnly("2027-05-03"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: product.id, stage: "CETAK", qtyGood: 20, qtyReject: 5, createdBy: "uji" } });
    await prisma.$transaction((tx) => postProductionStock(tx, e.id, actor));
    const js = (await prisma.journal.findMany({ where: { source: "PRODUKSI", sourceId: e.id } })).map((j) => j.id);
    expect(js.length).toBe(2);
    const beban = await net(js, COA.BEBAN_SELISIH_PERSEDIAAN);
    const bdp = await net(js, COA.PERSEDIAAN_BDP);
    expect(beban).toBeGreaterThan(0);
    // BDP hanya bertambah sebesar bahan untuk 20 pcs bagus (bahan 5 pcs reject sudah dibebankan)
    expect(bdp * 5).toBeCloseTo(beban * 20, -2);
  });

  it("pengeluaran bahan baku dibukukan ke beban selisih; stok minus terdeteksi", async () => {
    const { raw } = await locationSettings(prisma);
    const it = await prisma.item.create({ data: { sku: "BB-UJI-1108", name: "Bahan Uji 1108", type: "BAHAN_BAKU", unit: "pcs" } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 10, toLocationId: raw, unitCost: 1000, date: d("2027-05-04") }, actor));
    const mv = await prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: it.id, qty: 4, fromLocationId: raw, date: d("2027-05-04") }, actor));
    expect(mv.journalId).toBeTruthy();
    expect(await net([mv.journalId!], COA.BEBAN_SELISIH_PERSEDIAAN)).toBe(4000);
    expect(await net([mv.journalId!], COA.PERSEDIAAN_BAHAN)).toBe(-4000);
    await prisma.$transaction((tx) => recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: it.id, qty: 8, fromLocationId: raw!, allowNegative: true, date: d("2027-05-04") }, actor));
    expect((await negativeStock()).some((r) => r.itemId === it.id)).toBe(true);
  });

  it("opname barang jadi: yang berkurang dicatat sebagai HPP", async () => {
    const { finished } = await locationSettings(prisma);
    const it = await prisma.item.create({ data: { sku: "BJ-UJI-1108", name: "Produk Uji 1108", type: "BARANG_JADI", unit: "pcs" } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: it.id, qty: 10, toLocationId: finished, unitCost: 1500, date: d("2027-05-05") }, actor));
    const r = await finishedGoodsOpname([{ itemId: it.id, physical: 7 }], jakartaDateTime("2027-05-31", "23:00"), actor);
    expect(r).toMatchObject({ changed: 1, sold: 3, hpp: 4500 });
    expect(await qtyAt(prisma, it.id, finished!)).toBe(7);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: it.id, ref: "OPN-2027-05-31" } });
    expect(await net([mv.journalId!], COA.HPP)).toBe(4500);
    expect(await net([mv.journalId!], COA.PERSEDIAAN_JADI)).toBe(-4500);
    // Opname ulang dengan angka sama tidak mengubah apa pun
    expect((await finishedGoodsOpname([{ itemId: it.id, physical: 7 }], jakartaDateTime("2027-05-31", "23:00"), actor)).changed).toBe(0);
  });
});

describe("Audit 8 Nov paket 2/3: gaji, kasbon, pembelian", () => {
  it("gaji diakui sebagai hutang gaji saat disetujui; pembayaran & persetujuan bisa dibatalkan", async () => {
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K004" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly("2027-05-10"), status: "HADIR", validated: true } });
    const adv = await giveAdvance({ employeeId: emp.id, amount: 10_000, installment: 0, bankAccountId: seabank, storeId, date: "2027-05-09" }, actor);
    const p = await prisma.payrollPeriod.create({ data: { code: "UJI-1108", startDate: dateOnly("2027-05-10"), endDate: dateOnly("2027-05-16") } });
    await computePeriod(p.id, actor);
    await approvePeriod(p.id, actor);
    const acc = await prisma.journal.findFirstOrThrow({ where: { source: "PAYROLL_AKRUAL", sourceId: p.id } });
    expect(acc.date.toISOString().slice(0, 10)).toBe("2027-05-16");
    const gross = await net([acc.id], COA.BEBAN_GAJI_PRODUKSI);
    expect(gross).toBeGreaterThan(0);
    expect(await net([acc.id], COA.UTANG_GAJI)).toBe(-gross);

    await payPeriod(p.id, seabank, storeId, actor, d("2027-05-23"));
    const pj = await prisma.journal.findFirstOrThrow({ where: { source: "PAYROLL", sourceId: p.id } });
    expect(await net([pj.id], COA.UTANG_GAJI)).toBe(gross);
    expect(await net([pj.id], COA.BEBAN_GAJI_PRODUKSI)).toBe(0);
    expect(Number((await prisma.cashAdvance.findUniqueOrThrow({ where: { id: adv.id } })).repaid)).toBe(10_000);

    await cancelPayment(p.id, "salah rekening", actor);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DISETUJUI");
    expect(Number((await prisma.cashAdvance.findUniqueOrThrow({ where: { id: adv.id } })).repaid)).toBe(0);
    await unapprovePeriod(p.id, "hitung ulang", actor);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DRAFT");
    await approvePeriod(p.id, actor);
    await payPeriod(p.id, seabank, storeId, actor, d("2027-05-23"));
    // Semua jurnal periode ini (akrual, bayar, pembalik): hutang gaji bersih nol
    const all = await prisma.journal.findMany({ where: { OR: [{ sourceId: p.id }, { source: "PEMBALIK" }] } });
    const mine = all.filter((j) => j.sourceId === p.id || all.some((o) => o.id === j.reversalOfId && o.sourceId === p.id));
    expect(await net(mine.map((j) => j.id), COA.UTANG_GAJI)).toBe(0);
    expect(await net(mine.map((j) => j.id), COA.BEBAN_GAJI_PRODUKSI)).toBe(gross);
  });

  it("kasbon yang belum dipotong bisa dibatalkan", async () => {
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const a = await giveAdvance({ employeeId: emp.id, amount: 50_000, installment: 0, bankAccountId: seabank, storeId, date: "2027-05-20" }, actor);
    await cancelAdvance(a.id, "salah karyawan", actor);
    expect(await prisma.journal.count({ where: { reversalOfId: a.journalId! } })).toBe(1);
    expect((await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a.id } })).cancelledAt).not.toBeNull();
    await expect(cancelAdvance(a.id, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);
  });

  it("pembelian dibatalkan: jurnal dibalik, stok keluar, hutang dihapus", async () => {
    const { raw } = await locationSettings(prisma);
    const it = await prisma.item.create({ data: { sku: "BB-UJI-BELI-1108", name: "Bahan Beli Uji 1108", type: "BAHAN_BAKU", unit: "pcs" } });
    const p = await createPurchase({ supplierId: null, newSupplierName: "Supplier Uji 1108", storeId, date: d("2027-05-21"), term: "BERTAHAP", lines: [{ itemId: it.id, qty: 50, amount: 250_000 }], paidNow: 100_000, bankAccountId: seabank, dueDate: d("2027-06-21"), note: null }, actor);
    expect(await qtyAt(prisma, it.id, raw!)).toBe(50);
    await cancelPurchase(p.id, "salah qty", actor);
    expect(await qtyAt(prisma, it.id, raw!)).toBe(0);
    expect(await prisma.payable.count({ where: { id: p.payableId! } })).toBe(0);
    expect(await prisma.journal.count({ where: { reversalOfId: p.journalId! } })).toBe(1);
    await expect(cancelPurchase(p.id, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);

    const p2 = await createPurchase({ supplierId: null, newSupplierName: "Supplier Uji 1108", storeId, date: d("2027-05-21"), term: "TEMPO", lines: [{ itemId: it.id, qty: 10, amount: 50_000 }], paidNow: 0, bankAccountId: null, dueDate: d("2027-06-21"), note: null }, actor);
    await prisma.payable.update({ where: { id: p2.payableId! }, data: { paid: BigInt(10_000) } });
    await expect(cancelPurchase(p2.id, "x", actor)).rejects.toThrow(/sudah dicicil/);
  });
});

describe("Audit 8 Nov paket 3: hak akses", () => {
  it("Supervisor & Admin Produksi tidak melihat gaji semua karyawan, tetap bisa slip sendiri", () => {
    for (const role of ["SUPERVISOR", "ADMIN_PRODUKSI"] as const) {
      const p = effectivePermissions(role, []);
      expect(p.has("payroll.view")).toBe(false);
      expect(p.has("payroll.self")).toBe(true);
    }
  });
});
