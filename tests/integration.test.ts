import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createTransaction, approveAndBook, submitForConfirmation, rejectTransaction, updateTransaction, bankBalances } from "@/lib/finance";
import { profitLoss, balanceSheet, closePeriod, postJournal, cashFlow, COA, reverseJournal } from "@/lib/accounting";
import { recordMovement, postProductionStock, itemTotals, inventoryValuation, locationSettings } from "@/lib/stock";
import { computePeriod, approvePeriod, payPeriod } from "@/lib/payroll";
import { jakartaDateTime, dateOnly, monthRange } from "@/lib/time";

let actor: { id: string; name: string };
let bank: Record<string, string>;
let cat: Record<string, string>;
let storeId: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
  actor = { id: u.id, name: u.name };
  bank = Object.fromEntries((await prisma.bankAccount.findMany()).map((b) => [b.code, b.id]));
  cat = Object.fromEntries((await prisma.txCategory.findMany()).map((c) => [c.name, c.id]));
  storeId = (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id;
});

const d = (s: string) => jakartaDateTime(s, "10:00");

describe("Finance Inbox → pembukuan", () => {
  it("draft manual tidak membuat jurnal sampai disetujui", async () => {
    const { transaction: t } = await createTransaction({ direction: "MASUK", amount: 1_000_000, date: d("2026-09-02"), accountId: bank.SEABANK, categoryId: cat["Penjualan Produk"], storeId }, "MANUAL", actor);
    expect(t.status).toBe("DRAFT");
    expect(await prisma.journal.count({ where: { sourceId: t.id } })).toBe(0);
    await expect(approveAndBook(t.id, actor)).rejects.toThrow(/Menunggu Konfirmasi/);
    await submitForConfirmation(t.id, actor);
    const { journal } = await approveAndBook(t.id, actor);
    const lines = await prisma.journalLine.findMany({ where: { journalId: journal.id } });
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(1_000_000);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(1_000_000);
    await expect(approveAndBook(t.id, actor)).rejects.toThrow(/sudah dibukukan/);
    const logs = await prisma.approvalLog.findMany({ where: { transactionId: t.id } });
    expect(logs.map((l) => l.action)).toEqual(["DIBUAT", "DIAJUKAN", "DISETUJUI_DIBUKUKAN"]);
  });

  it("deteksi duplikat → Perlu Ditinjau", async () => {
    const input = { direction: "KELUAR" as const, amount: 350_000, date: d("2026-09-03"), accountId: bank.SEABANK, categoryId: cat["Listrik, Air & Gas"], storeId };
    const a = await createTransaction(input, "AI", actor);
    expect(a.transaction.status).toBe("MENUNGGU_KONFIRMASI");
    const b = await createTransaction({ ...input, date: d("2026-09-04") }, "AI", actor);
    expect(b.transaction.status).toBe("PERLU_DITINJAU");
    expect(b.transaction.duplicateOfId).toBe(a.transaction.id);
    await rejectTransaction(b.transaction.id, actor, "duplikat");
    await expect(updateTransaction(b.transaction.id, { amount: 1 }, actor)).rejects.toThrow();
  });

  it("idempotency key mencegah draft ganda", async () => {
    const input = { direction: "KELUAR" as const, amount: 77_000, date: d("2026-09-05"), accountId: bank.KAS, categoryId: cat["Transport"], idempotencyKey: "hermes-abc-123" };
    const a = await createTransaction(input, "AI", actor);
    const b = await createTransaction(input, "AI", actor);
    expect(b.replayed).toBe(true);
    expect(b.transaction.id).toBe(a.transaction.id);
  });

  it("transfer internal bukan pendapatan atau beban", async () => {
    const before = await profitLoss({});
    const { transaction: t } = await createTransaction({ direction: "TRANSFER", amount: 400_000, date: d("2026-09-06"), accountId: bank.SEABANK, toAccountId: bank.SHOPEEPAY, categoryId: cat["Penjualan Produk"], storeId }, "MANUAL", actor, { submit: true });
    expect(t.categoryId).toBeNull();
    await approveAndBook(t.id, actor);
    const after = await profitLoss({});
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.totalRevenue).toBe(before.totalRevenue);
    const bal = await bankBalances();
    expect(bal.find((b) => b.code === "SHOPEEPAY")!.balance).toBe(400_000);
    const cf = await cashFlow({ start: d("2026-09-06"), end: d("2026-09-07") });
    expect(cf.operating + cf.investing + cf.financing).toBe(0);
  });

  it("transfer ke rekening yang sama ditolak saat dibukukan", async () => {
    const { transaction: t } = await createTransaction({ direction: "TRANSFER", amount: 1000, date: d("2026-09-06"), accountId: bank.KAS, toAccountId: bank.KAS, storeId }, "MANUAL", actor);
    await expect(submitForConfirmation(t.id, actor)).rejects.toThrow(/berbeda/);
  });

  it("neraca seimbang", async () => {
    const bs = await balanceSheet(new Date("2027-01-01"));
    expect(bs.balanced).toBe(true);
  });
});

describe("Tutup buku & audit", () => {
  it("periode tertutup menolak pembukuan", async () => {
    await closePeriod(2026, 8, actor);
    await expect(
      postJournalTx(new Date("2026-08-15T03:00:00Z")),
    ).rejects.toThrow(/sudah ditutup/);
    const again = await closePeriod(2026, 8, actor);
    expect(again.alreadyClosed).toBe(true);
  });

  it("penyusutan aset diposting saat tutup buku", async () => {
    await prisma.fixedAsset.create({ data: { name: "Oven", storeId, acquiredAt: new Date("2026-06-01"), cost: BigInt(2_400_000), usefulLifeMonths: 24 } });
    const r = await closePeriod(2026, 7, actor);
    expect(r.depreciation).toBe(100_000);
  });

  it("audit log append-only & jurnal tidak bisa diubah", async () => {
    const log = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: log.id }, data: { action: "X" } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
    const j = await prisma.journal.findFirstOrThrow();
    await expect(prisma.journal.update({ where: { id: j.id }, data: { description: "ubah" } })).rejects.toThrow();
  });

  it("koreksi lewat jurnal pembalik", async () => {
    const j = await prisma.$transaction((tx) => postJournal(tx, { date: d("2026-09-10"), storeId, description: "uji", source: "MANUAL", actor, lines: [{ accountCode: COA.BEBAN_TRANSPORT, debit: 5000 }, { accountCode: COA.KAS, credit: 5000 }] }));
    const r = await prisma.$transaction((tx) => reverseJournal(tx, j.id, d("2026-09-10"), actor, "salah input"));
    expect(r.reversalOfId).toBe(j.id);
    await expect(prisma.$transaction((tx) => reverseJournal(tx, j.id, d("2026-09-10"), actor, "lagi"))).rejects.toThrow(/sudah pernah/);
  });
});

function postJournalTx(date: Date) {
  return prisma.$transaction((tx) => postJournal(tx, { date, storeId, description: "uji", source: "MANUAL", actor, lines: [{ accountCode: COA.KAS, debit: 1000 }, { accountCode: COA.MODAL, credit: 1000 }] }));
}

describe("Stok & produksi terintegrasi", () => {
  it("cetak mengonsumsi bahan sesuai BOM, barang jadi masuk gudang", async () => {
    const locs = await locationSettings(prisma);
    const gyp = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-GYP" } });
    const pls = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-PLS" } });
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: gyp.id, qty: 100, toLocationId: locs.raw, unitCost: 5000 }, actor);
      await recordMovement(tx, { type: "PENERIMAAN", itemId: pls.id, qty: 1000, toLocationId: locs.raw, unitCost: 150 }, actor);
    });
    await expect(prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: gyp.id, qty: 99999, fromLocationId: locs.raw }, actor))).rejects.toThrow(/tidak cukup/);

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const base = { date: dateOnly("2026-09-15"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: product.id, createdBy: "uji" };
    const e1 = await prisma.productionEntry.create({ data: { ...base, stage: "CETAK", qtyGood: 90, qtyReject: 10 } });
    await prisma.$transaction((tx) => postProductionStock(tx, e1.id, actor));
    const totals = await itemTotals();
    expect(totals.get(gyp.id)).toBeCloseTo(100 - 0.08 * 100, 5);
    expect(totals.get(pls.id)).toBe(1000 - 100);
    const e2 = await prisma.productionEntry.create({ data: { ...base, stage: "BARANG_JADI", qtyGood: 80, qtyReject: 0 } });
    await prisma.$transaction((tx) => postProductionStock(tx, e2.id, actor));
    const fin = await prisma.item.findUniqueOrThrow({ where: { sku: "BJ-SAT-COWOK" } });
    expect((await itemTotals()).get(fin.id)).toBe(80);
    // posting ulang tidak menggandakan
    await prisma.$transaction((tx) => postProductionStock(tx, e2.id, actor));
    expect((await itemTotals()).get(fin.id)).toBe(80);
    const val = await inventoryValuation();
    expect(val.byType.BARANG_JADI).toBeGreaterThan(0);
    const bs = await balanceSheet(new Date("2027-01-01"));
    expect(bs.balanced).toBe(true);
  });
});

describe("Penggajian → keuangan", () => {
  it("hitung, setujui, bayar membuat jurnal beban gaji", async () => {
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K004" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    for (const day of ["2026-09-21", "2026-09-22"]) {
      await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly(day), status: "HADIR", validated: true } });
    }
    await prisma.productionEntry.create({ data: { date: dateOnly("2026-09-21"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: product.id, stage: "ASSEMBLING", qtyGood: 100, createdBy: "uji" } });
    await prisma.transportTrip.create({ data: { employeeId: emp.id, date: dateOnly("2026-09-22"), amount: BigInt(20000) } });
    const p = await prisma.payrollPeriod.create({ data: { code: "UJI-2026-09", startDate: dateOnly("2026-09-21"), endDate: dateOnly("2026-09-27") } });
    await computePeriod(p.id, actor);
    const slip = await prisma.payslip.findUniqueOrThrow({ where: { periodId_employeeId: { periodId: p.id, employeeId: emp.id } } });
    expect(Number(slip.total)).toBe(2 * 50000 + 100 * 200 + 20000);
    await expect(payPeriod(p.id, bank.KAS, storeId, actor)).rejects.toThrow(/disetujui/);
    await approvePeriod(p.id, actor);
    const j = await payPeriod(p.id, bank.KAS, storeId, actor, d("2026-09-28"));
    const pl = await profitLoss({ start: monthRange(2026, 9).start, end: monthRange(2026, 9).end });
    expect(pl.expenses.find((e) => e.code === COA.BEBAN_TRANSPORT)?.amount).toBeGreaterThanOrEqual(20000);
    expect(j.number).toMatch(/^JU-/);
  });
});
